import {decodeEventLog, numberToHex, parseAbiItem, sliceHex, type Address, type Hex} from "viem";

import {serverEnv} from "@/lib/env";

import {entryPointAbi} from "./abis";
import {fromRevertData} from "./errors";
import {operatorAddress, operatorClient, publicClient} from "./clients";
import {activeChain, deployment} from "./config";
import {estimateFees} from "./gas";
import type {Signer} from "./signer";
import {
  buildUserOperation,
  signUserOperation,
  userOperationHash,
  type PackedUserOperation,
} from "./userOperation";

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
 * Собирает и подписывает операцию, но НЕ отправляет.
 *
 * Разделение нужно платежам: `userOpHash` известен уже здесь, до отправки. Записав его
 * в платёж заранее, мы получаем возможность найти операцию в логах EntryPoint, даже если
 * процесс умрёт сразу после отправки и `txHash` записать не успеет.
 *
 * Чем именно подписано — забота `Signer`: главным ключом с сервера, session key
 * платформы или эндпоинтом самого агента.
 */
export async function prepareAgentUserOperation(params: {
  sender: Address;
  callData: Hex;
  signer: Signer;
}): Promise<{userOp: PackedUserOperation; userOpHash: Hex}> {
  const {maxFeePerGas, maxPriorityFeePerGas} = await estimateFees();

  const userOp = await buildUserOperation({
    sender: params.sender,
    callData: params.callData,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const signed = await signUserOperation(userOp, params.signer);

  return {userOp: signed, userOpHash: await userOperationHash(signed)};
}

/** Отправка подписанной операции: локальный `handleOps` либо настоящий бандлер. */
export async function submitUserOperation(
  userOp: PackedUserOperation,
): Promise<{txHash: Hex}> {
  return bundler().send(userOp);
}

/**
 * Полный путь операции агента: собрать, подписать, отправить, убедиться, что отработала.
 * Используется там, где отдельного объекта платежа нет.
 */
export async function sendAgentUserOperation(params: {
  sender: Address;
  callData: Hex;
  signer: Signer;
}): Promise<{txHash: Hex}> {
  const {userOp, userOpHash} = await prepareAgentUserOperation(params);
  const result = await submitUserOperation(userOp);

  await assertUserOperationSucceeded(result.txHash, userOpHash);
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

export type UserOperationOutcome = {
  success: boolean;
  revertReason?: Hex;
  /** Блок, в котором операция исполнилась. Нужен, чтобы понять её глубину в цепи. */
  blockNumber: bigint;
};

/**
 * Чем кончилась операция по данным её транзакции.
 *
 * В ERC-4337 неудачное исполнение НЕ откатывает транзакцию: EntryPoint ловит revert,
 * списывает газ и отмечает операцию как `success: false`. Поэтому «транзакция в блоке»
 * и «платёж прошёл» — разные вещи, и различать их приходится по событиям.
 *
 * Смотрим только СВОЮ операцию: бандлер пакует в одну транзакцию операции разных
 * отправителей, и чужой `UserOperationEvent` с `success: false` не говорит ничего о
 * нашей. Поэтому события фильтруются по `userOpHash`, а «нашей операции в чеке нет» —
 * это `null` (неизвестно), а не успех: полный revert бандла оставляет чек без событий
 * вообще. `null` читается как «операцию ищет сверка», а не как «платёж не прошёл».
 */
export async function readUserOperationOutcome(
  txHash: Hex,
  userOpHash: Hex,
): Promise<UserOperationOutcome | null> {
  const receipt = await publicClient().getTransactionReceipt({hash: txHash});

  // Транзакция бандлера откатилась целиком — ни чьих операций в ней не исполнилось.
  if (receipt.status !== "success") {
    return null;
  }

  let found = false;
  let success = true;
  let revertReason: Hex | undefined;

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: USER_OPERATION_EVENTS,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.args.userOpHash !== userOpHash) {
        continue;
      }

      if (decoded.eventName === "UserOperationEvent") {
        found = true;
        if (decoded.args.success === false) {
          success = false;
        }
      }
      if (decoded.eventName === "UserOperationRevertReason") {
        revertReason = decoded.args.revertReason;
      }
    } catch {
      // Лог другого контракта — пропускаем.
    }
  }

  return found ? {success, revertReason, blockNumber: receipt.blockNumber} : null;
}

/**
 * Ищет операцию по её хешу в логах EntryPoint.
 *
 * Нужно для сверки платежей, у которых `txHash` записать не успели: `userOpHash` известен
 * до отправки, и по нему операцию всегда можно найти. Возвращает `null`, если операции в
 * сети нет — это не то же самое, что «не прошла»: она могла быть отвергнута бандлером и
 * вообще не попасть в блок.
 */
export async function findUserOperationByHash(
  userOpHash: Hex,
  fromBlock: bigint = 0n,
): Promise<({txHash: Hex} & UserOperationOutcome) | null> {
  const {entryPoint} = deployment();

  const logs = await publicClient().getLogs({
    address: entryPoint,
    event: USER_OPERATION_EVENTS[0],
    args: {userOpHash},
    fromBlock,
    toBlock: "latest",
  });

  const found = logs.at(-1);
  if (!found) {
    return null;
  }

  // Причину отказа несёт соседнее событие в той же транзакции, поэтому за ней идём
  // в чек, а не в этот лог.
  const outcome = await readUserOperationOutcome(found.transactionHash, userOpHash);
  if (!outcome) {
    return null;
  }
  return {txHash: found.transactionHash, ...outcome};
}

/**
 * Проверяет, что операция не только попала в блок, но и отработала.
 *
 * Без этой проверки API отвечал бы «оплачено» на трату, которую контракт отклонил.
 */
export async function assertUserOperationSucceeded(txHash: Hex, userOpHash: Hex): Promise<void> {
  const outcome = await readUserOperationOutcome(txHash, userOpHash);
  if (!outcome) {
    throw new Error(`Операция ${userOpHash} не найдена в транзакции ${txHash}.`);
  }
  if (!outcome.success) {
    throw fromRevertData(outcome.revertReason);
  }
}
