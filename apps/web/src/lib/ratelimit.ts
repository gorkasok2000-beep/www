/**
 * Ограничение частоты запросов и блокировка за неудачную аутентификацию.
 *
 * До появления этого модуля ограничений не было вовсе: API-ключ и админ-токен можно
 * было перебирать бесконечно, а дорогие эндпоинты — регистрация (создаёт кошелёк и
 * тратит газ оператора) и кран — дёргались бесплатно.
 *
 * Сознательное упрощение прототипа: состояние — in-memory внутри процесса. Лимиты
 * не переживают рестарт и не делятся между инстансами: за балансировщиком каждый
 * инстанс ведёт свои счётчики, и реальный потолок растёт пропорционально их числу.
 * В проде здесь нужен общий стор (Redis) или лимитер на edge; интерфейс модуля
 * подобран так, чтобы замена свелась к другой реализации тех же функций.
 *
 * Модуль ничего не импортирует из проекта: конфигурация передаётся параметрами, а
 * читается из окружения в точке интеграции (`api.ts`). Поэтому он тестируется голым
 * `node --test`, без Next.js и базы (`ratelimit.test.ts`).
 */

/**
 * IP клиента по заголовкам прокси.
 *
 * ВНИМАНИЕ: `x-forwarded-for` и `x-real-ip` подделываются клиентом, если перед
 * приложением нет доверенного прокси, который их перезаписывает. Доверять этим
 * заголовкам можно только когда запрос гарантированно прошёл через свой прокси;
 * иначе лимиты и блокировки обходятся подменой заголовка на каждый запрос.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Первый адрес в списке — исходный клиент, остальные добавили прокси по пути.
    return forwarded.split(",")[0].trim();
  }
  return request.headers.get("x-real-ip") ?? "local";
}

export type LimitVerdict = {ok: boolean; retryAfterSec: number};

const PASS: LimitVerdict = {ok: true, retryAfterSec: 0};

/** Скользящие окна: ключ правила → таймстемпы запросов и ширина окна. */
const buckets = new Map<string, {stamps: number[]; windowMs: number}>();

/** Неудачи аутентификации по IP. */
const authFailures = new Map<string, {stamps: number[]}>();

/** Активные блокировки: IP → метка времени, до которой IP заблокирован. */
const lockouts = new Map<string, number>();

export type AuthLockoutConfig = {
  /** Сколько неудач в окне приводит к блокировке. */
  threshold: number;
  /** Окно подсчёта неудач. */
  windowMs: number;
  /** Длительность блокировки. */
  durationMs: number;
  /** Мастер-выключатель: false — лимиты и блокировки отключены (e2e-стенды). */
  enabled: boolean;
};

const DEFAULT_LOCKOUT: AuthLockoutConfig = {
  threshold: 10,
  windowMs: 10 * 60_000,
  durationMs: 15 * 60_000,
  enabled: true,
};

let lockoutConfig = {...DEFAULT_LOCKOUT};

/**
 * Конфигурацию из окружения передаёт точка интеграции — так модуль не зависит от
 * process.env и остаётся тестируемым изолированно.
 */
export function configureAuthLockout(config: Partial<AuthLockoutConfig>): void {
  lockoutConfig = {...lockoutConfig, ...config};
}

/** Таймстемпы добавляются по порядку, поэтому протухшие — всегда префикс массива. */
function prune(stamps: number[], windowMs: number, now: number): number[] {
  const from = now - windowMs;
  let first = 0;
  while (first < stamps.length && stamps[first] <= from) first++;
  return first === 0 ? stamps : stamps.slice(first);
}

const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

/**
 * Периодическая общая чистка. На каждое обращение лениво чистится только затронутый
 * ключ; без общей чистки Map росли бы бесконечно от одноразовых ключей — каждый
 * новый IP оставлял бы запись навсегда.
 */
function sweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;

  for (const [key, bucket] of buckets) {
    bucket.stamps = prune(bucket.stamps, bucket.windowMs, now);
    if (bucket.stamps.length === 0) buckets.delete(key);
  }
  for (const [ip, entry] of authFailures) {
    entry.stamps = prune(entry.stamps, lockoutConfig.windowMs, now);
    if (entry.stamps.length === 0) authFailures.delete(ip);
  }
  for (const [ip, until] of lockouts) {
    if (until <= now) lockouts.delete(ip);
  }
}

/**
 * Скользящее окно: true, если запрос в пределах лимита (и учтён); иначе false и
 * число секунд, через которое из окна выйдет самый старый запрос (для Retry-After).
 *
 * Отклонённый запрос в окно НЕ записывается: иначе атакующий, ушедший за лимит,
 * держал бы себя заблокированным вечно, ни разу не пройдя.
 */
export function checkLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): LimitVerdict {
  if (!lockoutConfig.enabled) return PASS;
  sweep(now);

  const bucket = buckets.get(key) ?? {stamps: [], windowMs};
  // Один ключ мог попасть под правила с разными окнами — чистим по худшему.
  bucket.windowMs = Math.max(bucket.windowMs, windowMs);
  bucket.stamps = prune(bucket.stamps, windowMs, now);
  buckets.set(key, bucket);

  if (bucket.stamps.length >= limit) {
    const retryAfterMs = bucket.stamps[0] + windowMs - now;
    return {ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000))};
  }

  bucket.stamps.push(now);
  return PASS;
}

/**
 * Учитывает неудачную аутентификацию с IP. Набрав `threshold` неудач в окне
 * `windowMs`, IP блокируется на `durationMs`. Счётчик при этом обнуляется: после
 * окончания блока до следующей нужно снова набрать порог, а не заблокироваться от
 * первой же ошибки.
 */
export function recordAuthFailure(ip: string, now: number = Date.now()): void {
  if (!lockoutConfig.enabled) return;
  sweep(now);

  const entry = authFailures.get(ip) ?? {stamps: []};
  entry.stamps = prune(entry.stamps, lockoutConfig.windowMs, now);
  entry.stamps.push(now);
  authFailures.set(ip, entry);

  if (entry.stamps.length >= lockoutConfig.threshold) {
    lockouts.set(ip, now + lockoutConfig.durationMs);
    authFailures.delete(ip);
  }
}

/** Сколько секунд IP ещё заблокирован; 0 — не заблокирован. */
export function isLockedOut(ip: string, now: number = Date.now()): number {
  if (!lockoutConfig.enabled) return 0;

  const until = lockouts.get(ip);
  if (until === undefined) return 0;
  if (until <= now) {
    lockouts.delete(ip);
    return 0;
  }
  return Math.ceil((until - now) / 1000);
}

/** Успешная аутентификация обнуляет счётчик неудач: опечатка не копится вечно. */
export function clearAuthFailures(ip: string): void {
  authFailures.delete(ip);
}

/** Полный сброс состояния — нужен юнит-тестам, чтобы не протекать между кейсами. */
export function resetForTests(): void {
  buckets.clear();
  authFailures.clear();
  lockouts.clear();
  lockoutConfig = {...DEFAULT_LOCKOUT};
  lastSweepAt = 0;
}

/** Размеры внутренних таблиц — только для проверки вытеснения в тестах. */
export function sizeForTests(): {buckets: number; authFailures: number; lockouts: number} {
  return {buckets: buckets.size, authFailures: authFailures.size, lockouts: lockouts.size};
}
