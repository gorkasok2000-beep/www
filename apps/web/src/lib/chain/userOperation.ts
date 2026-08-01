import {concatHex, encodeFunctionData, numberToHex, pad, type Address, type Hex} from "viem";

import {agentAccountAbi, entryPointAbi} from "./abis";
import {publicClient} from "./clients";
import {deployment} from "./config";
import {estimateUserOperationGas, type GasEstimate} from "./gas";
import type {Signer} from "./signer";

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

/**
 * Собирает операцию: нонс из EntryPoint, лимиты газа из оценки, цена газа снаружи.
 *
 * @param gas готовая оценка, если она уже посчитана вызывающим кодом; иначе считается здесь
 */
export async function buildUserOperation(params: {
  sender: Address;
  callData: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas?: GasEstimate;
}): Promise<PackedUserOperation> {
  const {entryPoint} = deployment();

  const nonce = await publicClient().readContract({
    address: entryPoint,
    abi: entryPointAbi,
    functionName: "getNonce",
    args: [params.sender, 0n],
  });

  const gas =
    params.gas ??
    (await estimateUserOperationGas({
      sender: params.sender,
      nonce,
      callData: params.callData,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    }));

  return {
    sender: params.sender,
    nonce,
    initCode: "0x",
    callData: params.callData,
    accountGasLimits: packUint128Pair(gas.verificationGasLimit, gas.callGasLimit),
    preVerificationGas: gas.preVerificationGas,
    gasFees: packUint128Pair(params.maxPriorityFeePerGas, params.maxFeePerGas),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/** Хеш операции считает сам EntryPoint — так подпись гарантированно совпадёт с проверкой. */
export async function userOperationHash(userOp: PackedUserOperation): Promise<Hex> {
  const {entryPoint} = deployment();

  return publicClient().readContract({
    address: entryPoint,
    abi: entryPointAbi,
    functionName: "getUserOpHash",
    args: [userOp],
  });
}

/**
 * Подписывает операцию.
 *
 * Платформа не знает, где живёт ключ: `Signer` может быть локальным, session key или
 * вовсе удалённым эндпоинтом самого агента (см. `signer.ts`).
 */
export async function signUserOperation(
  userOp: PackedUserOperation,
  signer: Signer,
): Promise<PackedUserOperation> {
  const signature = await signer.sign(await userOperationHash(userOp));
  return {...userOp, signature};
}
