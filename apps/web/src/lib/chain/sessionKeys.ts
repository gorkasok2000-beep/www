import {createWalletClient, encodeFunctionData, http, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {serverEnv} from "@/lib/env";

import {agentAccountAbi} from "./abis";
import {publicClient} from "./clients";
import {activeChain} from "./config";
import {ensureGasAllowance} from "./registry";

/**
 * Работа с ключами ограниченного доступа на стороне контракта.
 *
 * Границы ключа — срок, бюджет, список получателей — живут в `AgentAccount`, а не здесь.
 * Задача этого модуля: собрать нужный вызов, отправить его тем, у кого есть право, и
 * прочитать результат из контракта, а не из базы.
 */

export type SessionKeyArgs = {
  signer: Address;
  validAfter: number;
  validUntil: number;
  budgetWei: bigint;
  targets: Address[];
};

export type OnchainSessionKey = {
  validAfter: number;
  validUntil: number;
  budgetWei: bigint;
  spentWei: bigint;
  targetsRestricted: boolean;
  /** Ключ зарегистрирован и не отозван: контракт кодирует это ненулевым сроком. */
  exists: boolean;
};

/**
 * calldata для `registerSessionKey`.
 *
 * Метод доступен только владельцу, поэтому транзакцию отправляет он сам — из браузера,
 * если главный ключ там, либо через платформу в прототипном режиме SERVER_KEY.
 */
export function encodeRegisterSessionKey(args: SessionKeyArgs): Hex {
  return encodeFunctionData({
    abi: agentAccountAbi,
    functionName: "registerSessionKey",
    args: [args.signer, args.validAfter, args.validUntil, args.budgetWei, args.targets],
  });
}

/** Состояние ключа по данным контракта — источник истины, в отличие от таблицы. */
export async function readSessionKey(
  account: Address,
  signer: Address,
): Promise<OnchainSessionKey> {
  const [validAfter, validUntil, budgetWei, spentWei, targetsRestricted] =
    await publicClient().readContract({
      address: account,
      abi: agentAccountAbi,
      functionName: "sessionKeys",
      args: [signer],
    });

  return {
    validAfter,
    validUntil,
    budgetWei,
    spentWei,
    targetsRestricted,
    exists: validUntil !== 0,
  };
}

/** Разрешён ли получатель конкретному ключу (когда у ключа есть список адресов). */
export async function isSessionTargetAllowed(
  account: Address,
  signer: Address,
  target: Address,
): Promise<boolean> {
  return publicClient().readContract({
    address: account,
    abi: agentAccountAbi,
    functionName: "sessionKeyTargets",
    args: [signer, target],
  });
}

/**
 * Регистрация ключа владельцем — прямой транзакцией EOA, а не через UserOperation.
 *
 * Так проще и надёжнее: `registerSessionKey` разрешён владельцу напрямую, значит не
 * нужны ни сборка операции, ни её нонс. Путь через `execute` внутри UserOperation тоже
 * работал бы, но упирался бы в whitelist кастодиана — получателем вызова оказался бы сам
 * кошелёк, и правило «платить только разрешённым адресам» его бы заблокировало.
 *
 * ПРОТОТИП: применяется только когда главный ключ агента лежит на сервере. В остальных
 * режимах эту транзакцию отправляет владелец сам — платформа отдаёт ему готовую calldata.
 */
export async function registerSessionKeyAsOwner(params: {
  account: Address;
  ownerPrivateKey: Hex;
  args: SessionKeyArgs;
}): Promise<Hex> {
  const owner = privateKeyToAccount(params.ownerPrivateKey);
  await ensureGasAllowance(owner.address);

  const client = createWalletClient({
    account: owner,
    chain: activeChain(),
    transport: http(serverEnv.rpcUrl()),
  });

  const txHash = await client.writeContract({
    account: owner,
    chain: activeChain(),
    address: params.account,
    abi: agentAccountAbi,
    functionName: "registerSessionKey",
    args: [
      params.args.signer,
      params.args.validAfter,
      params.args.validUntil,
      params.args.budgetWei,
      params.args.targets,
    ],
  });

  await publicClient().waitForTransactionReceipt({hash: txHash});
  return txHash;
}

/**
 * Отзыв ключа самим держателем.
 *
 * Контракт разрешает `revokeSessionKey` владельцу **или** самому ключу. Второе важно
 * именно для платформы: поняв, что скомпрометирована, она обрывает себе доступ
 * немедленно, не дожидаясь, пока владелец проснётся и подпишет отзыв.
 *
 * Через UserOperation это невозможно: session key вправе вызывать только `execute`, а
 * внутри `execute` вызывающим окажется сам кошелёк, который контракту не владелец и не
 * держатель ключа. Поэтому отзыв идёт прямой транзакцией с адреса ключа.
 */
export async function revokeSessionKeyAsHolder(params: {
  account: Address;
  sessionPrivateKey: Hex;
}): Promise<Hex> {
  const holder = privateKeyToAccount(params.sessionPrivateKey);
  await ensureGasAllowance(holder.address);

  const client = createWalletClient({
    account: holder,
    chain: activeChain(),
    transport: http(serverEnv.rpcUrl()),
  });

  const txHash = await client.writeContract({
    account: holder,
    chain: activeChain(),
    address: params.account,
    abi: agentAccountAbi,
    functionName: "revokeSessionKey",
    args: [holder.address],
  });

  await publicClient().waitForTransactionReceipt({hash: txHash});
  return txHash;
}
