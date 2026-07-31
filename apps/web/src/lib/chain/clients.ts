import {createPublicClient, createWalletClient, http, type PublicClient, type WalletClient} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {serverEnv} from "@/lib/env";

import {activeChain} from "./config";

let publicClientCache: PublicClient | undefined;

export function publicClient(): PublicClient {
  publicClientCache ??= createPublicClient({
    chain: activeChain(),
    transport: http(serverEnv.rpcUrl()),
  });
  return publicClientCache;
}

/**
 * Кошелёк оператора платформы. Выполняет две роли:
 *   1. регистрирует агентов в реестре (за газ платит платформа — у нового агента его нет);
 *   2. в локальной сети играет бандлера, отправляя `EntryPoint.handleOps`.
 *
 * В тестовой сети с настоящим бандлером вторая роль отпадает, см. `relayer.ts`.
 */
export function operatorClient(): WalletClient {
  const account = privateKeyToAccount(serverEnv.relayerPrivateKey() as `0x${string}`);
  return createWalletClient({
    account,
    chain: activeChain(),
    transport: http(serverEnv.rpcUrl()),
  });
}

export function operatorAddress(): `0x${string}` {
  return privateKeyToAccount(serverEnv.relayerPrivateKey() as `0x${string}`).address;
}

/**
 * Клиент кастодиана — им подписываются изменения правил.
 *
 * ПРОТОТИП: ключ кастодиана тоже хранится на сервере (см. `lib/crypto.ts`), потому что
 * подключения внешнего кошелька в MVP нет. В проде здесь должна быть подпись из браузера.
 */
export function custodianClient(privateKey: `0x${string}`): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: activeChain(),
    transport: http(serverEnv.rpcUrl()),
  });
}
