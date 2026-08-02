import {lookup} from "node:dns/promises";

import {isAddress, parseEther, type Address} from "viem";

import {AgentError, AGENT_MODES, type AgentMode} from "./agents";
import type {RulesInput} from "./chain/registry";
import {CHAIN_ID} from "./env";

/** Разбор входных данных API без внешних зависимостей — прототипу хватает. */

/**
 * Локальная сеть (anvil): там signerUrl агента закономерно живёт на localhost,
 * и SSRF-фильтры бы мешали разработке. На любой другой сети приватные адреса
 * в signerUrl запрещены — см. `parseSignerUrl` и `assertSignerUrlResolvesPublic`.
 */
const LOCAL_DEV = CHAIN_ID === 31337;

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
    let value: bigint;
    try {
      // parseEther принимает и отрицательные числа — отсекаем их сами.
      value = parseEther(String(body.valueEth));
    } catch {
      throw new AgentError("Поле valueEth должно быть числом в ETH.", 400);
    }
    if (value < 0n) {
      throw new AgentError("Поле valueEth не может быть отрицательным.", 400);
    }
    return value;
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

  // Number("abc") даёт NaN, а BigInt(NaN) бросает RangeError — без проверки это был
  // бы 500 вместо внятного 400.
  const rawPeriod = raw.periodSeconds === undefined ? 0 : Number(raw.periodSeconds);
  if (!Number.isInteger(rawPeriod) || rawPeriod < 0) {
    throw new AgentError("Поле periodSeconds должно быть неотрицательным целым числом.", 400);
  }
  const periodSeconds = BigInt(rawPeriod);

  return {
    limitWei,
    periodSeconds,
    whitelistEnabled: Boolean(raw.whitelistEnabled),
  };
}

/**
 * Эндпоинт агента, по которому платформа ходит сама: signerUrl (подпись) или
 * webhookUrl (уведомления).
 *
 * Без фильтров агент мог бы читать внутреннюю сеть через наш сервер (SSRF). Что
 * отсечено здесь, синхронно:
 *
 *   - схемы кроме http/https — иначе сервер дёргал бы `file:` и прочие протоколы;
 *   - логин/пароль в URL;
 *   - localhost и приватные/служебные IP-литералы (на локальной сети — разрешены,
 *     там эндпоинт агента закономерно живёт рядом).
 *
 * Для имён хостов дополнительно проверяется DNS-резолв при регистрации — см.
 * `assertUrlResolvesPublic`; а сами запросы идут с `redirect: "manual"`,
 * чтобы проверку нельзя было обойти ответом 302 (см. `chain/signer.ts`, `webhooks.ts`).
 */
export function parseSignerUrl(value: unknown): string | undefined {
  return parseEndpointUrl(value, "signerUrl");
}

export function parseWebhookUrl(value: unknown): string | undefined {
  return parseEndpointUrl(value, "webhookUrl");
}

function parseEndpointUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AgentError(`Поле ${field} должно быть строкой.`, 400);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentError(`Поле ${field} должно быть корректным URL.`, 400);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentError(`${field} должен использовать http или https.`, 400);
  }

  if (url.username || url.password) {
    throw new AgentError(`${field} не должен содержать логин и пароль.`, 400);
  }

  assertPublicHostname(url.hostname, field);

  return url.toString();
}

/**
 * DNS-резолв эндпоинта при регистрации: имя хоста не должно указывать на приватный
 * адрес. Без этого фильтр по литералу обходится доменом, который резолвится в
 * 127.0.0.1. Полной гарантии не даёт (DNS-rebinding между проверкой и запросом),
 * поэтому запрос дополнительно идёт без следования редиректам.
 */
export async function assertUrlResolvesPublic(url: string, field: string): Promise<void> {
  if (LOCAL_DEV) {
    return;
  }

  const bare = bareHostname(new URL(url).hostname);
  if (isPrivateIp(bare) || bare.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bare)) {
    return; // IP-литерал: приватный уже отклонён выше, публичному резолв не нужен
  }

  let addresses: {address: string}[];
  try {
    addresses = await lookup(bare, {all: true, verbatim: true});
  } catch {
    throw new AgentError(`Домен ${field} не резолвится: ${bare}.`, 400);
  }
  for (const {address} of addresses) {
    if (isPrivateIp(address)) {
      throw new AgentError(`${field} резолвится в приватный адрес ${address}.`, 400);
    }
  }
}

/**
 * Отсекает адреса, указывающие внутрь инфраструктуры. Вызывается и для литерала
 * из URL, и (через isPrivateIp) для каждого адреса из DNS-ответа.
 */
function assertPublicHostname(hostname: string, field: string): void {
  if (LOCAL_DEV) {
    return;
  }

  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new AgentError(`${field} не может указывать на localhost.`, 400);
  }
  if (isPrivateIp(bareHostname(host))) {
    throw new AgentError(`${field} не может указывать на приватный или служебный IP.`, 400);
  }
}

/** IPv6-адрес в URL приходит в квадратных скобках — снимаем их. */
function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Приватные, loopback, link-local, multicast и прочие немаршрутизируемые диапазоны. */
function isPrivateIp(ip: string): boolean {
  // IPv4, в том числе в записи IPv6 (::ffff:127.0.0.1).
  const v4 = ip.replace(/^::ffff:/i, "");
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 || // «этот хост»
      a === 10 || // RFC 1918
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) || // RFC 1918
      (a === 192 && b === 168) || // RFC 1918
      a >= 224 // multicast и зарезервированное
    );
  }
  if (ip.includes(":")) {
    const firstWord = parseInt(ip.split(":")[0] || "0", 16);
    return (
      ip === "::" ||
      ip === "::1" ||
      (firstWord & 0xfe00) === 0xfc00 || // fc00::/7 — unique local
      (firstWord & 0xffc0) === 0xfe80 // fe80::/10 — link-local
    );
  }
  return false; // не IP-литерал, а имя хоста — его проверяет DNS-резолв
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
