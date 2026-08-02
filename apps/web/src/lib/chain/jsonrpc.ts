import {AgentError} from "@/lib/agent-error";
import {describeError} from "@/lib/log";

/**
 * Транспорт до бандлера.
 *
 * Вынесен отдельно, потому что к бандлеру ходят двое — отправка операции (`relayer.ts`)
 * и оценка газа (`gas.ts`), — и различать «отверг» и «не достучались» они обязаны
 * одинаково. Две копии этой логики разошлись бы, и одна из них начала бы переспрашивать
 * запасной эндпоинт про операцию, которую основной уже честно отклонил.
 */

/**
 * «До бандлера не достучались»: сеть, таймаут, 5xx, нечитаемый ответ.
 *
 * Отдельный тип ошибки нужен ровно для одного решения — можно ли обратиться к следующему
 * бандлеру. Тут можно: этот про операцию ничего не узнал.
 *
 * Обратный случай — JSON-RPC-ошибка: бандлер операцию РАССМОТРЕЛ и отверг (плохая
 * подпись, нехватка предоплаты, слишком низкая цена газа). Нести её дальше по списку
 * бессмысленно: остальные ответят тем же, а агент вместо внятной причины получит
 * задержку в несколько таймаутов.
 *
 * Статус 503, а не 500: проблема не в запросе агента и не в нашем коде, а во внешнем
 * сервисе — такой ответ прямо говорит, что повторить попытку позже имеет смысл.
 */
export class BundlerUnreachable extends AgentError {
  constructor(message: string) {
    super(message, 503);
  }
}

/** Ответа бандлера ждём ограниченное время — иначе зависший эндпоинт держит запрос вечно. */
export const BUNDLER_TIMEOUT_MS = 15_000;

/**
 * Эндпоинт для логов — без пути и query.
 *
 * URL бандлера у большинства провайдеров содержит API-ключ; писать его целиком в лог
 * значит рано или поздно выложить ключ в систему сбора логов.
 */
export function bundlerLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "bundler";
  }
}

export async function bundlerRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = BUNDLER_TIMEOUT_MS,
): Promise<T> {
  const label = bundlerLabel(url);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new BundlerUnreachable(`${label} недоступен: ${describeError(error)}`);
  }

  // 5xx и 429 — про сам сервис, а не про операцию: он её не рассматривал.
  if (response.status >= 500 || response.status === 429) {
    throw new BundlerUnreachable(`${label} ответил HTTP ${response.status}.`);
  }

  let body: {result?: T; error?: {message: string}};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Не JSON-RPC вовсе: скорее всего между нами и бандлером стоит прокси.
    throw new BundlerUnreachable(`${label} вернул не JSON-RPC (HTTP ${response.status}).`);
  }

  // 502, а не 500: операцию рассмотрел и отклонил внешний сервис. Причина от бандлера
  // передаётся дословно — это единственное, что объясняет агенту отказ.
  if (body.error) {
    throw new AgentError(`Бандлер отклонил ${method}: ${body.error.message}`, 502);
  }
  return body.result as T;
}
