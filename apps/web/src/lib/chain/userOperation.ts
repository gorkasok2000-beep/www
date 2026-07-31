import {concatHex, encodeFunctionData, numberToHex, pad, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {agentAccountAbi, entryPointAbi} from "./abis";
import {publicClient} from "./clients";
import {deployment} from "./config";

/**
 * Сборка и подпись UserOperation.
 *
 * Хеш операции не пересчитывается на клиенте: его отдаёт сам EntryPoint через
 * `getUserOpHash`. Так подпись гарантированно совпадает с тем, что проверит контракт,
 * даже если версия EntryPoint поменяет схему хеширования (в v0.8 она стала EIP-712).
 */

export type PackedUserOperation = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

/** Лимиты газа прототипа: с запасом, чтобы не заниматься оценкой на локальной сети. */
export const DEFAULT_GAS = {
  verificationGasLimit: 500_000n,
  callGasLimit: 500_000n,
  preVerificationGas: 100_000n,
} as const;

/** Два uint128 в одном bytes32 — формат ERC-4337 v0.7+. */
export function packUint128Pair(high: bigint, low: bigint): Hex {
  return concatHex([pad(numberToHex(high), {size: 16}), pad(numberToHex(low), {size: 16})]);
}

/** calldata для `AgentAccount.execute` — оплата от имени агента. */
export function encodeExecute(to: Address, valueWei: bigint, data: Hex = "0x"): Hex {
  return encodeFunctionData({
    abi: agentAccountAbi,
    functionName: "execute",
    args: [to, valueWei, data],
  });
}

export async function buildUserOperation(params: {
  sender: Address;
  callData: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): Promise<PackedUserOperation> {
  const {entryPoint} = deployment();

  const nonce = await publicClient().readContract({
    address: entryPoint,
    abi: entryPointAbi,
    functionName: "getNonce",
    args: [params.sender, 0n],
  });

  return {
    sender: params.sender,
    nonce,
    initCode: "0x",
    callData: params.callData,
    accountGasLimits: packUint128Pair(DEFAULT_GAS.verificationGasLimit, DEFAULT_GAS.callGasLimit),
    preVerificationGas: DEFAULT_GAS.preVerificationGas,
    gasFees: packUint128Pair(params.maxPriorityFeePerGas, params.maxFeePerGas),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/** Подписывает операцию ключом агента. Хеш берём у EntryPoint. */
export async function signUserOperation(
  userOp: PackedUserOperation,
  ownerPrivateKey: Hex,
): Promise<PackedUserOperation> {
  const {entryPoint} = deployment();

  const userOpHash = await publicClient().readContract({
    address: entryPoint,
    abi: entryPointAbi,
    functionName: "getUserOpHash",
    args: [userOp],
  });

  const signature = await privateKeyToAccount(ownerPrivateKey).sign({hash: userOpHash});

  return {...userOp, signature};
}
