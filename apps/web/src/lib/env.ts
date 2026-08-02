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

  /** URL внешнего бандлера. Если пусто — операции идут напрямую в EntryPoint. */
  bundlerUrl: () => process.env.BUNDLER_URL || undefined,

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
};
