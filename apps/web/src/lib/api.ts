import {NextResponse} from "next/server";

import {AgentError} from "./agents";

/**
 * Общая обвязка API: JSON с bigint, единый формат ошибки и обработка `AgentError`.
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

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof AgentError) {
    return json({error: error.message}, {status: error.status});
  }

  const message = error instanceof Error ? error.message : "Внутренняя ошибка";
  console.error("[api]", error);
  return json({error: message}, {status: 500});
}

/** Оборачивает обработчик роута, чтобы не дублировать try/catch в каждом файле. */
export function route<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<NextResponse>,
) {
  return async (request: Request, ...args: Args): Promise<NextResponse> => {
    try {
      return await handler(request, ...args);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AgentError("Ожидается тело запроса в формате JSON.", 400);
  }
}
