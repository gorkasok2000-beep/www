import {NextResponse} from "next/server";

import {AgentError} from "./agents";
import {apiKeyFromRequest} from "./auth";
import {hashApiKey} from "./crypto";
import {serverEnv} from "./env";
import {describeError, log} from "./log";
import {checkLimit, clientIp, configureAuthLockout, isLockedOut} from "./ratelimit";

/**
 * Общая обвязка API: JSON с bigint, единый формат ошибки и обработка `AgentError`.
 *
 * Здесь же заводится идентификатор запроса. Он уходит клиенту заголовком `x-request-id`
 * и попадает во все логи этого запроса: без него разобрать инцидент по логам нельзя —
 * непонятно, какая строка к какому обращению относится.
 *
 * И здесь же, до вызова обработчика, применяются лимиты частоты запросов: обвязка —
 * единственная точка, через которую проходят все API-роуты, поэтому правилу достаточно
 * одного места (`ratelimit.ts`).
 */

/** bigint не сериализуется в JSON — отдаём его строкой, как принято для wei. */
function replacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return new NextResponse(JSON.stringify(data, replacer), {
    ...init,
    headers: {"content-type": "application/json", ...init?.headers},
  });
}

export function errorResponse(error: unknown, requestId?: string): NextResponse {
  if (error instanceof AgentError) {
    return json({error: error.message, requestId}, {status: error.status});
  }

  // Детали 500 остаются в серверном логе: сырой message может содержать внутренние
  // пути, параметры подключения или фрагменты секретов — наружу это не отдаём.
  // Идентификатор запроса отдаём: по нему нужную строку лога находят за секунду.
  log.error("request.failed", {requestId, error: describeError(error)});
  return json({error: "Внутренняя ошибка сервера.", requestId}, {status: 500});
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * 429 в том же формате, что и остальные ошибки (`{error, requestId}`), плюс
 * заголовок Retry-After — агент без человека в цикле должен понимать, когда повторять.
 */
function tooManyRequests(error: string, retryAfterSec: number, requestId: string): NextResponse {
  return json({error, requestId}, {status: 429, headers: {"retry-after": String(retryAfterSec)}});
}

/**
 * Правило лимита по пути. Три полки с разной ценой запроса:
 *
 * - `/api/v1/admin/*` — по IP, жёстко: туда ходят редко, а перебор админ-токена
 *   должен упираться быстро;
 * - `POST /api/v1/agents` (ровно этот путь, регистрация) — по IP, самое жёсткое:
 *   регистрация создаёт кошелёк и тратит газ оператора;
 * - всё остальное API — по идентичности: хеш API-ключа, а если ключа нет — по IP.
 *
 * В ключ Map и в лог идут только первые 16 символов хеша ключа — сырой ключ не
 * должен оказаться ни в памяти лимитера, ни в логах.
 */
function rateLimitRule(
  request: Request,
  path: string,
  ip: string,
): {key: string; limit: number; windowMs: number} {
  if (path.startsWith("/api/v1/admin/")) {
    return {key: `admin:${ip}`, limit: serverEnv.rateLimitAdminPerMin(), windowMs: MINUTE_MS};
  }
  if (path === "/api/v1/agents" && request.method === "POST") {
    return {key: `register:${ip}`, limit: serverEnv.rateLimitRegisterPerHour(), windowMs: HOUR_MS};
  }
  const apiKey = apiKeyFromRequest(request);
  const identity = apiKey ? `key:${hashApiKey(apiKey).slice(0, 16)}` : `ip:${ip}`;
  return {key: `api:${identity}`, limit: serverEnv.rateLimitApiPerMin(), windowMs: MINUTE_MS};
}

/** Оборачивает обработчик роута, чтобы не дублировать try/catch в каждом файле. */
export function route<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<NextResponse>,
) {
  return async (request: Request, ...args: Args): Promise<NextResponse> => {
    // Клиент может прислать свой идентификатор — тогда его цепочка вызовов и наши логи
    // сшиваются без дополнительной работы.
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const startedAt = Date.now();
    const path = new URL(request.url).pathname;

    let response: NextResponse | undefined;

    // Лимиты касаются только API: страницы и статику они ломать не должны. При
    // RATE_LIMIT_ENABLED=false весь блок — no-op (e2e-стенды). Конфигурация читается
    // здесь, в точке интеграции, а не в модуле лимитера — ради его тестируемости.
    if (path.startsWith("/api/")) {
      const enabled = serverEnv.rateLimitEnabled();
      const lockout = serverEnv.authLockout();
      configureAuthLockout({...lockout, enabled});

      if (enabled) {
        const ip = clientIp(request);

        const lockedFor = isLockedOut(ip);
        if (lockedFor > 0) {
          log.warn("ratelimit.lockout", {requestId, path, ip});
          response = tooManyRequests(
            "Слишком много неудачных попыток аутентификации. Повторите позже.",
            lockedFor,
            requestId,
          );
        } else {
          const rule = rateLimitRule(request, path, ip);
          const verdict = checkLimit(rule.key, rule.limit, rule.windowMs);
          if (!verdict.ok) {
            log.warn("ratelimit.tripped", {requestId, path, identity: rule.key});
            response = tooManyRequests(
              "Превышен лимит запросов. Повторите позже.",
              verdict.retryAfterSec,
              requestId,
            );
          }
        }
      }
    }

    if (!response) {
      try {
        response = await handler(request, ...args);
      } catch (error) {
        response = errorResponse(error, requestId);
      }
    }

    response.headers.set("x-request-id", requestId);
    log.info("request", {
      requestId,
      method: request.method,
      path,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });

    return response;
  };
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AgentError("Ожидается тело запроса в формате JSON.", 400);
  }
}
