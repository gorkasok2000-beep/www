import {NextResponse} from "next/server";

import {AgentError} from "./agents";
import {describeError, log} from "./log";

/**
 * Общая обвязка API: JSON с bigint, единый формат ошибки и обработка `AgentError`.
 *
 * Здесь же заводится идентификатор запроса. Он уходит клиенту заголовком `x-request-id`
 * и попадает во все логи этого запроса: без него разобрать инцидент по логам нельзя —
 * непонятно, какая строка к какому обращению относится.
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

    let response: NextResponse;
    try {
      response = await handler(request, ...args);
    } catch (error) {
      response = errorResponse(error, requestId);
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
