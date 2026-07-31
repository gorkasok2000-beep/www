import {cookies} from "next/headers";

import type {Agent} from "@/generated/prisma";

import {AgentError, findAgentByApiKey} from "./agents";
import {safeEqualHex} from "./crypto";
import {hashApiKey} from "./crypto";
import {serverEnv} from "./env";

/**
 * Аутентификация прототипа: один API-ключ на кошелёк.
 *
 * Агент шлёт `X-API-Key` (или `Authorization: Bearer …`) — этого достаточно, чтобы
 * действовать от имени своего кошелька. Человек в браузере получает тот же ключ в
 * httpOnly-cookie при регистрации, поэтому дашборд ходит в те же эндпоинты.
 *
 * Сознательно НЕ реализовано (вне MVP по ТЗ): роли, срок жизни ключей, ротация,
 * ограничение частоты запросов.
 */
export const API_KEY_COOKIE = "synth_api_key";

export function apiKeyFromRequest(request: Request): string | null {
  const header = request.headers.get("x-api-key");
  if (header) {
    return header.trim();
  }

  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return null;
}

/** Достаёт агента по ключу из заголовка, иначе из cookie сессии дашборда. */
export async function requireAgent(request: Request): Promise<Agent> {
  const fromHeader = apiKeyFromRequest(request);
  const apiKey = fromHeader ?? (await cookies()).get(API_KEY_COOKIE)?.value;

  if (!apiKey) {
    throw new AgentError("Нужен API-ключ: заголовок X-API-Key.", 401);
  }

  const agent = await findAgentByApiKey(apiKey);
  if (!agent) {
    throw new AgentError("Неизвестный API-ключ.", 401);
  }

  return agent;
}

/** Агент текущей сессии дашборда, если человек уже зарегистрировался. */
export async function currentAgent(): Promise<Agent | null> {
  const apiKey = (await cookies()).get(API_KEY_COOKIE)?.value;
  return apiKey ? findAgentByApiKey(apiKey) : null;
}

/** Админ-эндпоинт заморозки. Сравнение хешей — за постоянное время. */
export function requireAdmin(request: Request): void {
  const provided = apiKeyFromRequest(request);
  if (!provided || !safeEqualHex(hashApiKey(provided), hashApiKey(serverEnv.adminApiToken()))) {
    throw new AgentError("Требуется админ-токен.", 401);
  }
}
