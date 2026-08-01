import {formatEther, type Address, type Hex} from "viem";

import type {Agent, Payment} from "@/generated/prisma";

import {AgentError} from "./agent-error";
import {signerFor} from "./agents";
import {fromRevertData, toAgentError} from "./chain/errors";
import {syncTransactionLogs} from "./chain/indexer";
import {simulateExecute} from "./chain/registry";
import {
  findUserOperationByHash,
  prepareAgentUserOperation,
  readUserOperationOutcome,
  submitUserOperation,
} from "./chain/relayer";
import {encodeExecute} from "./chain/userOperation";
import {hashRequest} from "./crypto";
import {db} from "./db";
import {assertSessionKeyAllows} from "./session-keys";

/**
 * Платежи агента.
 *
 * Почему платёж — объект, а не «запрос вернул 201». Агент ретраит по своему усмотрению,
 * человека в цикле нет. Поэтому:
 *
 *   - повтор запроса с тем же `Idempotency-Key` возвращает первый результат и НИЧЕГО не
 *     отправляет в сеть. Тот же ключ с другим телом — ошибка агента, а не сети, и получает
 *     409;
 *   - у платежа есть состояние, а не только «получилось/не получилось». Если ответ не
 *     дошёл, агент спрашивает `GET /payments/<id>` и узнаёт правду;
 *   - правду о состоянии даёт блокчейн, а не эта таблица: сверка ищет операцию по
 *     `userOpHash` и переписывает статус по факту.
 */

export type PaymentInput = {
  idempotencyKey: string;
  to: Address;
  valueWei: bigint;
  data?: Hex;
  invoiceId?: string;
};

/** Промежуточные состояния: платёж начат, чем кончился — ещё неизвестно. */
const IN_FLIGHT = ["CREATED", "SUBMITTED"];

export async function payWithIdempotency(
  agent: Agent,
  input: PaymentInput,
): Promise<{payment: Payment; replayed: boolean}> {
  const data = input.data ?? "0x";
  const requestHash = hashRequest({
    to: input.to,
    valueWei: input.valueWei.toString(),
    data,
    invoiceId: input.invoiceId ?? "",
  });

  const existing = await db.payment.findUnique({
    where: {agentId_idempotencyKey: {agentId: agent.id, idempotencyKey: input.idempotencyKey}},
  });

  if (existing) {
    return {payment: assertSameRequest(existing, requestHash), replayed: true};
  }

  // Два платежа одного кошелька, идущие одновременно, взяли бы один и тот же нонс, и
  // второй развалился бы на валидации. Менеджер нонсов — за рамками прототипа, поэтому
  // честный отказ вместо непонятной ошибки из EntryPoint.
  const inFlight = await db.payment.findFirst({
    where: {agentId: agent.id, status: {in: IN_FLIGHT}},
  });
  if (inFlight) {
    throw new AgentError(
      `Предыдущий платёж ${inFlight.id} ещё выполняется. Дождитесь его завершения: ` +
        "GET /api/v1/agents/me/payments/" + inFlight.id,
      409,
    );
  }

  let payment: Payment;
  try {
    payment = await db.payment.create({
      data: {
        agentId: agent.id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        to: input.to,
        valueWei: input.valueWei.toString(),
        data,
        invoiceId: input.invoiceId ?? null,
      },
    });
  } catch {
    // Гонка: параллельный запрос с тем же ключом успел создать запись первым.
    const raced = await db.payment.findUnique({
      where: {agentId_idempotencyKey: {agentId: agent.id, idempotencyKey: input.idempotencyKey}},
    });
    if (!raced) {
      throw new AgentError("Не удалось создать платёж.", 500);
    }
    return {payment: assertSameRequest(raced, requestHash), replayed: true};
  }

  return {payment: await execute(agent, payment), replayed: false};
}

function assertSameRequest(payment: Payment, requestHash: string): Payment {
  if (payment.requestHash !== requestHash) {
    throw new AgentError(
      `Ключ идемпотентности «${payment.idempotencyKey}» уже использован для другого платежа ` +
        `(${formatEther(BigInt(payment.valueWei))} ETH на ${payment.to}). ` +
        "Для нового платежа нужен новый ключ.",
      409,
    );
  }
  return payment;
}

/**
 * Выполняет уже созданный платёж.
 *
 * Любая ошибка после создания записи переводит платёж в `FAILED` с причиной: запись
 * не должна оставаться в `CREATED`, иначе агент не отличит «не начинали» от «не смогли».
 * Повтор с тем же ключом вернёт `FAILED` — для новой попытки нужен новый ключ.
 */
async function execute(agent: Agent, payment: Payment): Promise<Payment> {
  const account = agent.accountAddress as Address;
  const to = payment.to as Address;
  const valueWei = BigInt(payment.valueWei);
  const data = payment.data as Hex;

  try {
    const signer = await signerFor(agent);

    // Сухой прогон: правила кошелька проверяются до траты газа.
    try {
      await simulateExecute({account, owner: agent.ownerAddress as Address, to, valueWei, data});
    } catch (error) {
      throw toAgentError(error);
    }

    // Границы session key контракт применяет на фазе валидации, куда сухой прогон
    // `execute` не заглядывает, — проверяем их отдельно, чтением состояния ключа.
    if (signer.mode === "SESSION_KEY") {
      await assertSessionKeyAllows({account, signer: signer.address, to, valueWei});
    }

    const {userOp, userOpHash} = await prepareAgentUserOperation({
      sender: account,
      callData: encodeExecute(to, valueWei, data),
      signer,
    });

    // userOpHash записывается ДО отправки: если процесс умрёт следующей строкой,
    // сверка найдёт операцию по нему, не имея txHash.
    await db.payment.update({
      where: {id: payment.id},
      data: {status: "SUBMITTED", userOpHash},
    });

    const {txHash} = await submitUserOperation(userOp);
    const outcome = await readUserOperationOutcome(txHash);

    const finished = await finalize(payment.id, {
      txHash,
      success: outcome.success,
      revertReason: outcome.revertReason,
    });

    // Свежий лог сразу после оплаты — чтобы транзакция появилась в дашборде без задержки.
    await syncTransactionLogs();

    if (!outcome.success) {
      throw fromRevertData(outcome.revertReason);
    }
    return finished;
  } catch (error) {
    const agentError = toAgentError(error);
    await db.payment.update({
      where: {id: payment.id},
      data: {status: "FAILED", failureReason: agentError.message},
    });
    throw agentError;
  }
}

/** Переводит платёж в конечное состояние и, если платёж по счёту, закрывает счёт. */
async function finalize(
  paymentId: string,
  result: {txHash: Hex; success: boolean; revertReason?: Hex},
): Promise<Payment> {
  const payment = await db.payment.update({
    where: {id: paymentId},
    data: {
      txHash: result.txHash,
      status: result.success ? "CONFIRMED" : "FAILED",
      failureReason: result.success ? null : fromRevertData(result.revertReason).message,
    },
  });

  if (result.success && payment.invoiceId) {
    await db.invoice.update({
      where: {id: payment.invoiceId},
      data: {status: "PAID", paidAt: new Date()},
    });
  }

  return payment;
}

/**
 * Сверка незавершённых платежей с блокчейном.
 *
 * Источник истины — сеть, а не таблица. Платежи, которых в сети не нашлось, остаются
 * `SUBMITTED`: «не найдено» не равно «не прошло», операция могла быть отвергнута
 * бандлером и не попасть в блок, а могла ещё не попасть.
 */
export async function reconcilePayments(agent: Agent): Promise<number> {
  const pending = await db.payment.findMany({
    where: {agentId: agent.id, status: "SUBMITTED"},
  });

  let updated = 0;
  for (const payment of pending) {
    const found = payment.txHash
      ? {txHash: payment.txHash as Hex, ...(await readUserOperationOutcome(payment.txHash as Hex))}
      : payment.userOpHash
        ? await findUserOperationByHash(payment.userOpHash as Hex)
        : null;

    if (!found) {
      continue;
    }

    await finalize(payment.id, found);
    updated++;
  }

  return updated;
}

export async function listPayments(agent: Agent, limit = 50): Promise<Payment[]> {
  await reconcilePayments(agent);
  return db.payment.findMany({
    where: {agentId: agent.id},
    orderBy: {createdAt: "desc"},
    take: limit,
  });
}

export async function getPayment(agent: Agent, id: string): Promise<Payment> {
  const payment = await db.payment.findFirst({where: {id, agentId: agent.id}});
  if (!payment) {
    throw new AgentError(`Платёж ${id} не найден.`, 404);
  }

  if (payment.status !== "SUBMITTED") {
    return payment;
  }

  await reconcilePayments(agent);
  return (await db.payment.findUnique({where: {id}})) ?? payment;
}

/** Представление платежа в API: wei строкой, суммы продублированы в ETH. */
export function paymentView(payment: Payment) {
  return {
    id: payment.id,
    status: payment.status.toLowerCase(),
    to: payment.to,
    valueWei: payment.valueWei,
    valueEth: formatEther(BigInt(payment.valueWei)),
    userOpHash: payment.userOpHash,
    txHash: payment.txHash,
    failureReason: payment.failureReason,
    invoiceId: payment.invoiceId,
    createdAt: payment.createdAt.toISOString(),
  };
}
