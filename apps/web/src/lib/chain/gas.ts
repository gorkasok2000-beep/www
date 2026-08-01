import {numberToHex, type Address, type Hex} from "viem";

import {serverEnv} from "@/lib/env";

import {publicClient} from "./clients";
import {deployment} from "./config";

/**
 * Оценка газа для UserOperation.
 *
 * Раньше здесь стояли три константы «с запасом». На локальной сети это работает, в
 * настоящей — нет: заниженный лимит роняет операцию, завышенный замораживает лишние
 * средства кошелька на предоплате (EntryPoint резервирует
 * `(verification + call + preVerification) × maxFeePerGas` и возвращает
 * неизрасходованное только после исполнения).
 *
 * Есть два источника оценки:
 *
 *   1. **Бандлер** — `eth_estimateUserOperationGas`. Единственный правильный ответ в
 *      настоящей сети: только бандлер знает свою наценку и, на L2, стоимость публикации
 *      calldata в L1. Используется, если задан `BUNDLER_URL`.
 *   2. **Локальная оценка** — когда бандлера нет (anvil). Считаем то, что можем: газ
 *      исполнения через `eth_estimateGas` от имени EntryPoint, стоимость calldata по
 *      правилам EVM, фазу валидации — константой.
 */

export type GasEstimate = {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
};

/**
 * Запас к оценке исполнения: 25%.
 *
 * `eth_estimateGas` даёт точную цифру для состояния «сейчас», а операция попадёт в блок
 * позже — к тому времени, например, изменится окно лимита трат или получатель из пустого
 * станет непустым (это меняет стоимость записи).
 */
const CALL_GAS_MARGIN_PERCENT = 125n;

/**
 * Фаза валидации: восстановление подписи, чтение состояния кошелька, разбор callData
 * для session key, при нехватке депозита — перевод предоплаты в EntryPoint.
 *
 * Оценить её через `eth_estimateGas` нельзя: `validateUserOp` вызывается только из
 * EntryPoint и только с корректной подписью, которой на момент сборки ещё нет. Поэтому
 * здесь честная константа с запасом, а не мнимая точность.
 */
const VERIFICATION_GAS_LIMIT = 200_000n;

/** Нижняя граница на случай, если оценка не удалась или вернула подозрительно мало. */
const MIN_CALL_GAS = 50_000n;

/**
 * Накладные расходы вне вызова аккаунта: доля транзакции бандлера, разбор операции
 * в EntryPoint, эмиссия события.
 */
const PRE_VERIFICATION_OVERHEAD = 40_000n;

/** Стоимость байта calldata в EVM: нулевой — 4 газа, ненулевой — 16. */
function calldataGas(data: Hex): bigint {
  const bytes = data.slice(2).match(/.{2}/g) ?? [];
  let total = 0n;
  for (const byte of bytes) {
    total += byte === "00" ? 4n : 16n;
  }
  return total;
}

export type EstimateInput = {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export async function estimateUserOperationGas(params: EstimateInput): Promise<GasEstimate> {
  const bundlerUrl = serverEnv.bundlerUrl();
  if (bundlerUrl) {
    return estimateViaBundler(bundlerUrl, params);
  }
  return estimateLocally(params);
}

/**
 * Оценка бандлером. Подпись на этом этапе ещё не готова, поэтому подставляется заглушка
 * нужной длины: бандлеры принимают её именно для оценки — важен размер calldata, а не
 * валидность.
 */
const DUMMY_SIGNATURE: Hex = `0x${"01".repeat(64)}1c`;

async function estimateViaBundler(url: string, params: EstimateInput): Promise<GasEstimate> {
  const {entryPoint} = deployment();

  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_estimateUserOperationGas",
      params: [
        {
          sender: params.sender,
          nonce: numberToHex(params.nonce),
          callData: params.callData,
          maxFeePerGas: numberToHex(params.maxFeePerGas),
          maxPriorityFeePerGas: numberToHex(params.maxPriorityFeePerGas),
          signature: DUMMY_SIGNATURE,
        },
        entryPoint,
      ],
    }),
  });

  const body = (await response.json()) as {
    result?: {callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex};
    error?: {message: string};
  };

  if (body.error || !body.result) {
    throw new Error(
      `Бандлер отклонил eth_estimateUserOperationGas: ${body.error?.message ?? "пустой ответ"}`,
    );
  }

  return {
    callGasLimit: BigInt(body.result.callGasLimit),
    verificationGasLimit: BigInt(body.result.verificationGasLimit),
    preVerificationGas: BigInt(body.result.preVerificationGas),
  };
}

/**
 * Локальная оценка.
 *
 * `callGasLimit` считается симуляцией вызова аккаунта от имени EntryPoint — контракт
 * разрешает этот путь, поэтому цифра получается настоящая. Если симуляция не удалась
 * (например, трата нарушает правило), берётся нижняя граница: разбираться с причиной —
 * дело предполётной проверки `simulateExecute`, а не оценщика газа.
 */
async function estimateLocally(params: EstimateInput): Promise<GasEstimate> {
  const {entryPoint} = deployment();

  let callGasLimit = MIN_CALL_GAS;
  try {
    const estimated = await publicClient().estimateGas({
      account: entryPoint,
      to: params.sender,
      data: params.callData,
    });
    callGasLimit = (estimated * CALL_GAS_MARGIN_PERCENT) / 100n;
  } catch {
    // Оценка не удалась — работаем по нижней границе.
  }

  return {
    callGasLimit: callGasLimit > MIN_CALL_GAS ? callGasLimit : MIN_CALL_GAS,
    verificationGasLimit: VERIFICATION_GAS_LIMIT,
    preVerificationGas: PRE_VERIFICATION_OVERHEAD + calldataGas(params.callData),
  };
}

/**
 * Цена газа.
 *
 * `estimateFeesPerGas` берёт базовую комиссию последнего блока и добавляет приоритетную.
 * Раньше здесь стояло `gasPrice * 2` — на сети с растущей базовой комиссией этого может
 * не хватить, а на спокойной это двойная переплата.
 *
 * Нижняя граница нужна для anvil: там базовая комиссия быстро уходит в ноль, и операция
 * с нулевой ценой газа никогда не попадёт в блок.
 */
const MIN_PRIORITY_FEE = 1_000_000_000n; // 1 gwei

export async function estimateFees(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const client = publicClient();

  try {
    const fees = await client.estimateFeesPerGas();
    const maxPriorityFeePerGas =
      fees.maxPriorityFeePerGas > MIN_PRIORITY_FEE ? fees.maxPriorityFeePerGas : MIN_PRIORITY_FEE;
    const maxFeePerGas =
      fees.maxFeePerGas > maxPriorityFeePerGas ? fees.maxFeePerGas : maxPriorityFeePerGas;

    return {maxFeePerGas, maxPriorityFeePerGas};
  } catch {
    // Сеть без EIP-1559 (или нода без истории комиссий) — откатываемся к простой цене.
    const gasPrice = await client.getGasPrice();
    const maxFeePerGas = gasPrice * 2n > MIN_PRIORITY_FEE ? gasPrice * 2n : MIN_PRIORITY_FEE;
    return {maxFeePerGas, maxPriorityFeePerGas: maxFeePerGas};
  }
}

/**
 * Во сколько обойдётся операция в худшем случае — столько EntryPoint удержит как
 * предоплату. Нужно, чтобы объяснить агенту «баланса хватает на платёж, но не на газ».
 */
export function maxCost(gas: GasEstimate, maxFeePerGas: bigint): bigint {
  return (gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas) * maxFeePerGas;
}
