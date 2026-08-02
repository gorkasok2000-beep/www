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
  type UserOperationOutcome,
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

/**
 * Сколько платёж может оставаться в CREATED. Дольше — значит процесс упал между
 * созданием записи и отправкой: сеть такой платёж не видела и уже не увидит.
 */
const CREATED_TTL_MS = 5 * 60 * 1000;

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
    const checked = assertSameRequest(existing, requestHash);
    if (isStaleCreated(checked)) {
      // «Зомби» от упавшего процесса не должен ни блокировать агента, ни возвращаться
      // ретраем как живой: гасим его в FAILED, и новая попытка пойдёт с новым ключом.
      return {payment: await expireCreated(db, checked), replayed: true};
    }
    return {payment: checked, replayed: true};
  }

  // Два платежа одного кошелька, идущие одновременно, взяли бы один и тот же нонс, и
  // второй развалился бы на валидации. Менеджер нонсов — за рамками прототипа, поэтому
  // честный отказ вместо непонятной ошибки из EntryPoint. Проверка и создание идут в
  // одной транзакции, иначе два конкурентных запроса оба проходили проверку до того,
  // как хоть один успевал создать запись.
  let payment: Payment;
  try {
    payment = await db.$transaction(async (tx) => {
      // SQLite допускает лишь одного писателя на всю базу: эта формальная запись
      // захватывает writer-lock до конца транзакции, и параллельный платёж того же
      // агента увидит нашу строку вместо того, чтобы проскочить с тем же нонсом.
      await tx.$executeRaw`UPDATE "Agent" SET "id" = "id" WHERE "id" = ${agent.id}`;

      // CREATED старше TTL — следы процессов, упавших между созданием записи и
      // отправкой: сеть их не видела. Гасим их в FAILED и освобождаем счета, иначе
      // такой «зомби» навсегда блокировал бы агента ответом 409.
      const stale = await tx.payment.findMany({
        where: {
          agentId: agent.id,
          status: "CREATED",
          createdAt: {lt: new Date(Date.now() - CREATED_TTL_MS)},
        },
      });
      for (const zombie of stale) {
        await expireCreated(tx, zombie);
      }

      const inFlight = await tx.payment.findFirst({
        where: {agentId: agent.id, status: {in: IN_FLIGHT}},
      });
      if (inFlight) {
        throw new AgentError(
          `Предыдущий платёж ${inFlight.id} ещё выполняется. Дождитесь его завершения: ` +
            "GET /api/v1/agents/me/payments/" + inFlight.id,
          409,
        );
      }

      // Оплату счёта нельзя начать дважды: захват OPEN -> PAYING атомарен, и второй
      // претендент (хоть этот же агент, хоть другой) получит count = 0. Счёт вернётся
      // в OPEN, если платёж заведомо не прошёл.
      if (input.invoiceId) {
        const captured = await tx.invoice.updateMany({
          where: {id: input.invoiceId, status: "OPEN"},
          data: {status: "PAYING"},
        });
        if (captured.count === 0) {
          throw new AgentError(`Счёт ${input.invoiceId} уже оплачен или оплачивается.`, 409);
        }
      }

      return tx.payment.create({
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
    });
  } catch (error) {
    if (error instanceof AgentError) {
      throw error;
    }
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

/** CREATED старше TTL — не живой платёж, а след процесса, упавшего до отправки. */
function isStaleCreated(payment: Payment): boolean {
  return payment.status === "CREATED" && Date.now() - payment.createdAt.getTime() > CREATED_TTL_MS;
}

/**
 * Гасит «зомби»-платёж: CREATED, которому процесс не дал дойти до отправки. Сеть его
 * не видела, поэтому честный итог — FAILED; захваченный счёт возвращается в OPEN.
 */
async function expireCreated(
  client: Pick<typeof db, "payment" | "invoice">,
  payment: Payment,
): Promise<Payment> {
  // updateMany с условием на статус, а не update: если платёж всё-таки жив и уже
  // ушёл в SUBMITTED, гасить его нельзя — сеть могла его увидеть.
  const expired = await client.payment.updateMany({
    where: {id: payment.id, status: "CREATED"},
    data: {
      status: "FAILED",
      failureReason: "Платёж не отправлен: обработка прервана до отправки в сеть.",
    },
  });
  if (expired.count > 0 && payment.invoiceId) {
    await client.invoice.updateMany({
      where: {id: payment.invoiceId, status: "PAYING"},
      data: {status: "OPEN"},
    });
  }
  return client.payment.findUniqueOrThrow({where: {id: payment.id}});
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
 * Жизненный цикл разделён на две фазы, и ошибки в них стоят по-разному:
 *
 *   - ДО отправки (симуляция, сборка, подпись) сеть платёж не видела, поэтому любая
 *     ошибка честно переводит его в FAILED с причиной, а захваченный счёт возвращается
 *     в OPEN. Повтор с тем же ключом вернёт FAILED — для новой попытки нужен новый ключ;
 *   - ПОСЛЕ отправки ошибка статуса НЕ меняет: операция могла уйти в сеть, и ложный
 *     FAILED спровоцирует агента заплатить второй раз. Платёж остаётся SUBMITTED,
 *     и правду о нём скажет сверка с блокчейном (`reconcilePayments`).
 */
async function execute(agent: Agent, payment: Payment): Promise<Payment> {
  const account = agent.accountAddress as Address;
  const to = payment.to as Address;
  const valueWei = BigInt(payment.valueWei);
  const data = payment.data as Hex;

  // Фаза 1 — до отправки.
  let prepared: Awaited<ReturnType<typeof prepareAgentUserOperation>>;
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

    prepared = await prepareAgentUserOperation({
      sender: account,
      callData: encodeExecute(to, valueWei, data),
      signer,
    });
  } catch (error) {
    throw await failBeforeSubmit(payment, error);
  }

  const {userOp, userOpHash} = prepared;

  // userOpHash записывается ДО отправки: если процесс умрёт следующей строкой,
  // сверка найдёт операцию по нему, не имея txHash.
  await db.payment.update({
    where: {id: payment.id},
    data: {status: "SUBMITTED", userOpHash},
  });

  // Фаза 2 — после отправки. Отсюда и дальше ошибки не трогают статус платежа.
  let txHash: Hex;
  try {
    ({txHash} = await submitUserOperation(userOp));
  } catch (error) {
    throw toAgentError(error);
  }

  await db.payment.update({where: {id: payment.id}, data: {txHash}});

  let outcome: Awaited<ReturnType<typeof readUserOperationOutcome>>;
  try {
    outcome = await readUserOperationOutcome(txHash, userOpHash);
  } catch {
    outcome = null;
  }

  if (!outcome) {
    // RPC-флап при чтении чека либо нашей операции нет в транзакции бандлера. Это
    // «неизвестно», а не «не прошло»: отдаём платёж как SUBMITTED, итог агент узнает
    // через GET /api/v1/agents/me/payments/<id> после сверки.
    return (await db.payment.findUnique({where: {id: payment.id}})) ?? payment;
  }

  const finished = await finalize(payment.id, {
    txHash,
    success: outcome.success,
    revertReason: outcome.revertReason,
  });

  // Свежий лог сразу после оплаты — чтобы транзакция появилась в дашборде без задержки.
  // Best-effort и вне критичного пути: сбой индексатора не имеет права менять статус
  // уже завершённого платежа.
  try {
    await syncTransactionLogs();
  } catch (error) {
    console.warn("syncTransactionLogs после платежа не удался:", error);
  }

  if (!outcome.success) {
    throw fromRevertData(outcome.revertReason);
  }
  return finished;
}

/**
 * Фиксирует отказ ДО отправки: сеть платёж не видела, поэтому запись не должна
 * оставаться в CREATED — иначе агент не отличит «не начинали» от «не смогли».
 * Захваченный счёт освобождается для новой попытки.
 */
async function failBeforeSubmit(payment: Payment, error: unknown): Promise<AgentError> {
  const agentError = toAgentError(error);
  await db.payment.update({
    where: {id: payment.id},
    data: {status: "FAILED", failureReason: agentError.message},
  });
  if (payment.invoiceId) {
    await db.invoice.updateMany({
      where: {id: payment.invoiceId, status: "PAYING"},
      data: {status: "OPEN"},
    });
  }
  return agentError;
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

  // Счёт трогаем, только если он всё ещё захвачен этим платежом (PAYING): успех
  // закрывает его, подтверждённый сетью отказ возвращает в OPEN для новой попытки.
  if (payment.invoiceId) {
    await db.invoice.updateMany({
      where: {id: payment.invoiceId, status: "PAYING"},
      data: result.success ? {status: "PAID", paidAt: new Date()} : {status: "OPEN"},
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
    let found: ({txHash: Hex} & UserOperationOutcome) | null = null;
    if (payment.txHash && payment.userOpHash) {
      const outcome = await readUserOperationOutcome(
        payment.txHash as Hex,
        payment.userOpHash as Hex,
      );
      found = outcome ? {txHash: payment.txHash as Hex, ...outcome} : null;
    } else if (payment.userOpHash) {
      found = await findUserOperationByHash(payment.userOpHash as Hex);
    }

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
