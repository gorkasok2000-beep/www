/**
 * Переменные окружения в одном месте, с понятными ошибками вместо `undefined`
 * где-нибудь в глубине запроса.
 */

/** Единственная переменная, доступная и на клиенте. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "31337");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Не задана переменная окружения ${name}. Скопируйте .env.example в apps/web/.env.local.`,
    );
  }
  return value;
}

/** Целое положительное из окружения с дефолтом — для лимитов и порогов. */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} должен быть целым положительным числом.`);
  }
  return parsed;
}

export const serverEnv = {
  rpcUrl: () => process.env.RPC_URL ?? "http://127.0.0.1:8545",

  /**
   * Бандлеры, через которые уходят операции. Если пусто — операции идут напрямую в
   * EntryPoint (локальный стенд, где бандлера нет).
   *
   * Список через запятую: `BUNDLER_URL=https://main,https://backup`. Бандлер — внешний
   * сервис, и его недоступность иначе означает, что платить нельзя вообще; порядок в
   * списке задаёт приоритет, перебор — в `FallbackBundler`.
   */
  bundlerUrls: (): string[] =>
    // BUNDLER_FALLBACK_URL — отдельная переменная для одного запасного эндпоинта;
    // приписывается в конец списка, чтобы оба способа задать запасной работали.
    [process.env.BUNDLER_URL ?? "", process.env.BUNDLER_FALLBACK_URL ?? ""]
      .join(",")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),

  /** Первый бандлер из списка — там, где перебор не нужен (оценка газа). */
  bundlerUrl: () => serverEnv.bundlerUrls()[0],

  /** EOA, который отправляет `handleOps` в локальной сети (роль бандлера). */
  relayerPrivateKey: () => required("RELAYER_PRIVATE_KEY"),

  /** 32 байта в hex — ключ шифрования приватных ключей агентов. */
  encryptionKey: () => required("APP_ENCRYPTION_KEY"),

  adminApiToken: () => required("ADMIN_API_TOKEN"),

  /**
   * Тестовый кран и выдача газа владельцам ключей. На публичной сети обязан быть
   * выключен (FAUCET_ENABLED=false): регистрация открыта, и без этого флага кошелёк
   * оператора сольют через кран и «бесплатный» газ.
   */
  faucetEnabled: () => process.env.FAUCET_ENABLED !== "false",

  /**
   * Сколько блоков должно лечь поверх блока с операцией, прежде чем платёж считается
   * подтверждённым.
   *
   * Ноль означает «верим первому же блоку». Для anvil это правда: там нет ни другого
   * майнера, ни реорга. В настоящей сети это ложь — блок с транзакцией бандлера может
   * быть вытеснен, и платёж, помеченный `CONFIRMED` на нулевой глубине, останется
   * подтверждённым навсегда, хотя денег никто не получил.
   *
   * Поэтому по умолчанию: 0 локально, 2 в тестовых сетях. Значение из окружения важнее.
   */
  confirmationBlocks: () => {
    const configured = process.env.CONFIRMATION_BLOCKS;
    if (configured !== undefined && configured !== "") {
      const parsed = Number(configured);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("CONFIRMATION_BLOCKS должен быть целым неотрицательным числом.");
      }
      return BigInt(parsed);
    }
    return CHAIN_ID === 31337 ? 0n : 2n;
  },

  /**
   * Разрешён ли режим `SERVER_KEY` — тот, в котором главный ключ агента генерирует и
   * хранит платформа.
   *
   * Это прототипный путь: он удобен для локальной разработки и демонстрации, но на
   * публичной сети означает, что компрометация сервера стоит всех средств всех агентов.
   * Уже созданные такие кошельки продолжают работать — флаг закрывает только выдачу
   * новых.
   */
  allowServerKeyMode: () =>
    process.env.ALLOW_SERVER_KEY_MODE
      ? process.env.ALLOW_SERVER_KEY_MODE !== "false"
      : CHAIN_ID === 31337,

  /**
   * Мастер-выключатель ограничения частоты запросов и блокировки по неудачной
   * аутентификации (`src/lib/ratelimit.ts`). Выключается только на e2e-стендах,
   * где скрипту нужно сотни раз дёргать API с одного адреса.
   */
  rateLimitEnabled: () => process.env.RATE_LIMIT_ENABLED !== "false",

  /** Общий лимит запросов в минуту на идентичность (хеш API-ключа, иначе IP). */
  rateLimitApiPerMin: () => positiveInt("RATE_LIMIT_API_PER_MIN", 300),

  /**
   * Лимит регистраций в час с одного IP. Отдельно и жёстко: регистрация создаёт
   * кошелёк и тратит газ оператора, поэтому бесплатной её быть не должно.
   */
  rateLimitRegisterPerHour: () => positiveInt("RATE_LIMIT_REGISTER_PER_HOUR", 10),

  /** Лимит запросов к /api/v1/admin/* в минуту с одного IP. */
  rateLimitAdminPerMin: () => positiveInt("RATE_LIMIT_ADMIN_PER_MIN", 30),

  /**
   * Блокировка IP за перебор ключей: после threshold неудач аутентификации в окне
   * windowMin минут все запросы с этого IP отклоняются durationMin минут.
   */
  authLockout: () => ({
    threshold: positiveInt("AUTH_LOCKOUT_THRESHOLD", 10),
    windowMs: positiveInt("AUTH_LOCKOUT_WINDOW_MIN", 10) * 60_000,
    durationMs: positiveInt("AUTH_LOCKOUT_DURATION_MIN", 15) * 60_000,
  }),
};
