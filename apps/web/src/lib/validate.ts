import {isAddress, parseEther, type Address} from "viem";

import {AgentError, AGENT_MODES, type AgentMode} from "./agents";
import type {RulesInput} from "./chain/registry";

/** Разбор входных данных API без внешних зависимостей — прототипу хватает. */

export function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new AgentError(`Поле ${field} должно быть Ethereum-адресом.`, 400);
  }
  return value;
}

export function parseMode(value: unknown): AgentMode {
  if (typeof value !== "string" || !AGENT_MODES.includes(value as AgentMode)) {
    throw new AgentError(`Поле mode должно быть одним из: ${AGENT_MODES.join(", ")}.`, 400);
  }
  return value as AgentMode;
}

/**
 * Сумма принимается либо в wei (`valueWei`), либо в ETH (`valueEth`) — агенту удобнее
 * первое, человеку в форме второе.
 */
export function parseValue(body: {valueWei?: unknown; valueEth?: unknown}): bigint {
  if (typeof body.valueWei === "string" || typeof body.valueWei === "number") {
    try {
      const value = BigInt(body.valueWei);
      if (value < 0n) {
        throw new Error();
      }
      return value;
    } catch {
      throw new AgentError("Поле valueWei должно быть неотрицательным целым числом.", 400);
    }
  }

  if (typeof body.valueEth === "string" || typeof body.valueEth === "number") {
    try {
      return parseEther(String(body.valueEth));
    } catch {
      throw new AgentError("Поле valueEth должно быть числом в ETH.", 400);
    }
  }

  throw new AgentError("Укажите сумму: valueWei или valueEth.", 400);
}

export function parseRules(value: unknown): RulesInput {
  if (typeof value !== "object" || value === null) {
    throw new AgentError("Поле rules должно быть объектом.", 400);
  }

  const raw = value as {limitEth?: unknown; limitWei?: unknown; periodSeconds?: unknown; whitelistEnabled?: unknown};

  const limitWei =
    raw.limitEth === undefined && raw.limitWei === undefined
      ? 0n
      : parseValue({valueWei: raw.limitWei, valueEth: raw.limitEth});

  const periodSeconds = raw.periodSeconds === undefined ? 0n : BigInt(Number(raw.periodSeconds));
  if (periodSeconds < 0n) {
    throw new AgentError("Поле periodSeconds не может быть отрицательным.", 400);
  }

  return {
    limitWei,
    periodSeconds,
    whitelistEnabled: Boolean(raw.whitelistEnabled),
  };
}

/**
 * Эндпоинт, у которого платформа спрашивает подпись.
 *
 * Платформа сама ходит по этому адресу, поэтому схема ограничена http/https: иначе
 * агент мог бы заставить сервер дёрнуть `file:` или другой внутренний протокол.
 * Полноценная защита от SSRF (запрет приватных диапазонов, резолв DNS до запроса) —
 * задача продакшена, здесь отсечены только очевидные случаи.
 */
export function parseSignerUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AgentError("Поле signerUrl должно быть строкой.", 400);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentError("Поле signerUrl должно быть корректным URL.", 400);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentError("signerUrl должен использовать http или https.", 400);
  }

  return url.toString();
}

/**
 * Ключ идемпотентности из заголовка `Idempotency-Key`.
 *
 * Обязателен для платежа — и это не формальность. Агент повторяет запрос сам, по своей
 * логике ретраев, и без ключа второй запрос стал бы вторым платежом: заметить это
 * некому, человека в цикле нет.
 *
 * Исключение — оплата по счёту: там ключом служит идентификатор самого счёта.
 */
export function parseIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim();

  if (!key) {
    throw new AgentError(
      "Нужен заголовок Idempotency-Key: без него повтор запроса стал бы вторым платежом. " +
        "Подойдёт любая уникальная строка, например crypto.randomUUID().",
      400,
    );
  }

  if (key.length > 128) {
    throw new AgentError("Idempotency-Key длиннее 128 символов.", 400);
  }

  return key;
}

export function parseWhitelist(value: unknown): Address[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AgentError("Поле whitelist должно быть массивом адресов.", 400);
  }
  return value.map((entry, index) => parseAddress(entry, `whitelist[${index}]`));
}
