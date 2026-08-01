import {decodeEventLog, numberToHex, parseAbiItem, sliceHex, type Address, type Hex} from "viem";

import {serverEnv} from "@/lib/env";

import {entryPointAbi} from "./abis";
import {fromRevertData} from "./errors";
import {operatorAddress, operatorClient, publicClient} from "./clients";
import {activeChain, deployment} from "./config";
import {estimateFees} from "./gas";
import type {Signer} from "./signer";
import {buildUserOperation, signUserOperation, type PackedUserOperation} from "./userOperation";

/**
 * Отправка UserOperation в сеть.
 *
 * ERC-4337 предполагает бандлер — отдельный сервис, который собирает операции в пул и
 * пакует их в транзакцию. На локальном anvil никакого бандлера нет, поэтому прототип
 * сам вызывает `EntryPoint.handleOps` с EOA оператора: для контракта это тот же путь
 * исполнения, что и в проде. Как только появится URL настоящего бандлера, включается
 * `RpcBundler` — код кошелька и API при этом не меняются.
 */
export interface Bundler {
  readonly kind: "local" | "rpc";
  send(userOp: PackedUserOperation): Promise<{txHash: Hex}>;
}

class LocalHandleOpsBundler implements Bundler {
  readonly kind = "local";

  async send(userOp: PackedUserOperation): Promise<{txHash: Hex}> {
    const {entryPoint} = deployment();
    const client = operatorClient();

    const txHash = await client.writeContract({
      account: client.account!,
      chain: activeChain(),
      address: entryPoint,
      abi: entryPointAbi,
      functionName: "handleOps",
      args: [[userOp], operatorAddress()],
    });

    await publicClient().waitForTransactionReceipt({hash: txHash});
    return {txHash};
  }
}

class RpcBundler implements Bundler {
  readonly kind = "rpc";

  constructor(private readonly url: string) {}

  async send(userOp: PackedUserOperation): Promise<{txHash: Hex}> {
    const {entryPoint} = deployment();

    // Бандлеры принимают «распакованный» формат, а не PackedUserOperation.
    const userOpHash = await this.rpc<Hex>("eth_sendUserOperation", [unpack(userOp), entryPoint]);
    const receipt = await this.waitForReceipt(userOpHash);

    return {txHash: receipt.receipt.transactionHash};
  }

  private async waitForReceipt(
    userOpHash: Hex,
    attempts = 30,
  ): Promise<{receipt: {transactionHash: Hex}}> {
    for (let i = 0; i < attempts; i++) {
      const receipt = await this.rpc<{receipt: {transactionHash: Hex}} | null>(
        "eth_getUserOperationReceipt",
        [userOpHash],
      );
      if (receipt) {
        return receipt;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Бандлер не вернул receipt для операции ${userOpHash}.`);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
    });

    const body = (await response.json()) as {result?: T; error?: {message: string}};
    if (body.error) {
      throw new Error(`Бандлер отклонил ${method}: ${body.error.message}`);
    }
    return body.result as T;
  }
}

/** Обратная распаковка bytes32-полей в формат JSON-RPC бандлера. */
function unpack(userOp: PackedUserOperation) {
  return {
    sender: userOp.sender,
    nonce: numberToHex(userOp.nonce),
    callData: userOp.callData,
    verificationGasLimit: sliceHex(userOp.accountGasLimits, 0, 16),
    callGasLimit: sliceHex(userOp.accountGasLimits, 16, 32),
    preVerificationGas: numberToHex(userOp.preVerificationGas),
    maxPriorityFeePerGas: sliceHex(userOp.gasFees, 0, 16),
    maxFeePerGas: sliceHex(userOp.gasFees, 16, 32),
    signature: userOp.signature,
  };
}

export function bundler(): Bundler {
  const url = serverEnv.bundlerUrl();
  return url ? new RpcBundler(url) : new LocalHandleOpsBundler();
}

/**
 * Полный путь операции агента: собрать, подписать, отправить, убедиться, что отработала.
 *
 * Чем именно подписано — забота `Signer`: главным ключом с сервера, session key
 * платформы или эндпоинтом самого агента. Отправка от этого не зависит.
 */
export async function sendAgentUserOperation(params: {
  sender: Address;
  callData: Hex;
  signer: Signer;
}): Promise<{txHash: Hex}> {
  const {maxFeePerGas, maxPriorityFeePerGas} = await estimateFees();

  const userOp = await buildUserOperation({
    sender: params.sender,
    callData: params.callData,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const signed = await signUserOperation(userOp, params.signer);
  const result = await bundler().send(signed);

  await assertUserOperationSucceeded(result.txHash);
  return result;
}

const USER_OPERATION_EVENTS = [
  parseAbiItem(
    "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  ),
  parseAbiItem(
    "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
  ),
] as const;

/**
 * Проверяет, что операция не только попала в блок, но и отработала.
 *
 * В ERC-4337 неудачное исполнение НЕ откатывает транзакцию: EntryPoint ловит revert,
 * списывает газ и отмечает операцию как `success: false`. Без этой проверки API
 * отвечал бы «оплачено» на трату, которую контракт на самом деле отклонил.
 */
export async function assertUserOperationSucceeded(txHash: Hex): Promise<void> {
  const receipt = await publicClient().getTransactionReceipt({hash: txHash});

  let failed = false;
  let revertReason: Hex | undefined;

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: USER_OPERATION_EVENTS,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === "UserOperationEvent" && decoded.args.success === false) {
        failed = true;
      }
      if (decoded.eventName === "UserOperationRevertReason") {
        revertReason = decoded.args.revertReason;
      }
    } catch {
      // Лог другого контракта — пропускаем.
    }
  }

  if (failed) {
    throw fromRevertData(revertReason);
  }
}
