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
    (process.env.BUNDLER_URL ?? "")
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
};
