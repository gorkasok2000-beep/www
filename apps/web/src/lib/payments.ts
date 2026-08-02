import {formatEther, type Address, type Hex} from "viem";

import type {Agent, Payment} from "@/generated/prisma";

import {AgentError} from "./agent-error";
import {serverEnv} from "./env";
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
import {describeError, log} from "./log";
import {publicClient} from "./chain/clients";
import {db} from "./db";
import {assertSessionKeyAllows} from "./session-keys";
import {enqueueWebhook, processWebhookQueue} from "./webhooks";

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
 * Условие «платёж занимает нонс кошелька».
 *
 * Нонс держит только операция, которая ещё не попала в блок. Как только известен
 * `blockNumber`, нонс израсходован, и следующий платёж можно собирать — даже если этот
 * ещё дозревает до нужной глубины подтверждений. Без этого уточнения агент с ненулевым
 * `CONFIRMATION_BLOCKS` не мог бы заплатить второй раз, пока цепь не подрастёт.
 */
const HOLDS_NONCE = {status: {in: IN_FLIGHT}, blockNumber: null} as const;

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
        where: {agentId: agent.id, ...HOLDS_NONCE},
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
  log.info("payment.submitted", {
    agentId: agent.id,
    paymentId: payment.id,
    userOpHash,
    to: payment.to,
    valueWei: payment.valueWei,
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

  const finished = await finalize(payment.id, {txHash, ...outcome});
  log.info(outcome.success ? `payment.${finished.status.toLowerCase()}` : "payment.rejected", {
    agentId: agent.id,
    paymentId: payment.id,
    userOpHash,
    txHash,
    blockNumber: outcome.blockNumber.toString(),
  });

  // Свежий лог сразу после оплаты — чтобы транзакция появилась в дашборде без задержки.
  // Best-effort и вне критичного пути: сбой индексатора не имеет права менять статус
  // уже завершённого платежа.
  try {
    await syncTransactionLogs();
  } catch (error) {
    log.warn("indexer.sync_failed", {
      paymentId: payment.id,
      txHash,
      error: describeError(error),
    });
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
  await enqueueWebhook(
    payment.agentId,
    "payment.failed",
    paymentEventData({...payment, status: "FAILED", failureReason: agentError.message}),
  );
  return agentError;
}

/** Данные события для вебхука — то же, что агент видит в API платежа. */
function paymentEventData(payment: Payment): Record<string, unknown> {
  return {
    paymentId: payment.id,
    status: payment.status.toLowerCase(),
    to: payment.to,
    valueWei: payment.valueWei,
    userOpHash: payment.userOpHash,
    txHash: payment.txHash,
    failureReason: payment.failureReason,
    invoiceId: payment.invoiceId,
  };
}

/**
 * Записывает исход операции и, если он окончательный, закрывает платёж.
 *
 * «Окончательный» — не то же самое, что «есть событие в чеке». Блок с транзакцией
 * бандлера может быть вытеснен реоргом, и платёж, помеченный `CONFIRMED` на нулевой
 * глубине, останется подтверждённым навсегда: сверка смотрит только незавершённые.
 * Поэтому успех признаётся, лишь когда поверх блока легло `CONFIRMATION_BLOCKS` блоков;
 * до тех пор платёж ждёт в `SUBMITTED` с уже записанными `txHash` и `blockNumber`.
 *
 * Отказ фиксируется сразу и без выдержки: ложный `FAILED` заставит агента заплатить
 * ещё раз новым ключом, но не создаст иллюзии, что деньги ушли.
 */
async function finalize(
  paymentId: string,
  result: {txHash: Hex; success: boolean; revertReason?: Hex; blockNumber: bigint},
): Promise<Payment> {
  const confirmed = result.success ? await isDeepEnough(result.blockNumber) : true;

  const payment = await db.payment.update({
    where: {id: paymentId},
    data: {
      txHash: result.txHash,
      blockNumber: result.blockNumber.toString(),
      status: result.success ? (confirmed ? "CONFIRMED" : "SUBMITTED") : "FAILED",
      failureReason: result.success ? null : fromRevertData(result.revertReason).message,
    },
  });

  // Счёт трогаем, только если он всё ещё захвачен этим платежом (PAYING): успех
  // закрывает его, подтверждённый сетью отказ возвращает в OPEN для новой попытки.
  // Незрелый успех счёт не отпускает — он всё ещё оплачивается.
  let invoicePaid = false;
  if (payment.invoiceId && (confirmed || !result.success)) {
    const closed = await db.invoice.updateMany({
      where: {id: payment.invoiceId, status: "PAYING"},
      data: result.success ? {status: "PAID", paidAt: new Date()} : {status: "OPEN"},
    });
    invoicePaid = result.success && closed.count > 0;
  }

  // Уведомления — после фиксации состояния: событие описывает уже записанный факт.
  // Повторы возможны (at-least-once), агент отсекает их по id доставки.
  if (payment.status === "CONFIRMED") {
    await enqueueWebhook(payment.agentId, "payment.confirmed", paymentEventData(payment));
  } else if (payment.status === "FAILED") {
    await enqueueWebhook(payment.agentId, "payment.failed", paymentEventData(payment));
  }
  if (invoicePaid && payment.invoiceId) {
    await enqueueWebhook(payment.agentId, "invoice.paid", {
      invoiceId: payment.invoiceId,
      paymentId: payment.id,
      txHash: payment.txHash,
    });
  }

  return payment;
}

/** Ушёл ли блок на глубину, с которой реорг его уже не вытеснит. */
async function isDeepEnough(blockNumber: bigint): Promise<boolean> {
  const depth = serverEnv.confirmationBlocks();
  if (depth === 0n) {
    return true;
  }

  // cacheTime: 0 — иначе viem вернёт голову, закэшированную до отправки нашей операции.
  const head = await publicClient().getBlockNumber({cacheTime: 0});
  return head >= blockNumber + depth;
}

/**
 * Возвращает платёж, чью операцию сеть больше не помнит.
 *
 * Такое бывает после реорга: блок с транзакцией бандлера вытеснен, событие исчезло.
 * Правильный ответ — не `FAILED` (операция могла быть переупакована в новый блок), а
 * снова `SUBMITTED`: пусть сверка ищет её дальше. Счёт при этом остаётся захваченным.
 */
async function markReorged(payment: Payment): Promise<Payment> {
  log.warn("payment.reorged", {
    agentId: payment.agentId,
    paymentId: payment.id,
    userOpHash: payment.userOpHash ?? undefined,
    txHash: payment.txHash ?? undefined,
    blockNumber: payment.blockNumber ?? undefined,
  });

  const updated = await db.payment.update({
    where: {id: payment.id},
    data: {
      status: "SUBMITTED",
      txHash: null,
      blockNumber: null,
      failureReason:
        "Блок с операцией вытеснен из цепи (реорг). Платёж снова ждёт подтверждения.",
    },
  });

  // Особенно важное событие: агент мог уже считать деньги полученными.
  await enqueueWebhook(payment.agentId, "payment.reorged", paymentEventData(updated));
  return updated;
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
    const found = await locate(payment);
    if (!found) {
      continue;
    }

    await finalize(payment.id, found);
    updated++;
  }

  const total = updated + (await recheckRecentlyConfirmed(agent));

  // Заодно гоняем очередь вебхуков: активность агента — естественный момент
  // для повторных попыток доставки.
  await processWebhookQueue();

  return total;
}

/**
 * Перепроверяет платежи, подтверждённые совсем недавно.
 *
 * Без этого шага `CONFIRMED` был бы вечным: сверка смотрит только незавершённые, а
 * реорг вытесняет блок уже после того, как платёж закрыт. Пока блок не ушёл на глубину
 * подтверждений, его нужно перечитывать — и, если операции в сети больше нет, честно
 * вернуть платёж в `SUBMITTED`.
 */
async function recheckRecentlyConfirmed(agent: Agent): Promise<number> {
  const depth = serverEnv.confirmationBlocks();
  if (depth === 0n) {
    // Локальная сеть: реорга не бывает, перечитывать нечего.
    return 0;
  }

  const head = await publicClient().getBlockNumber({cacheTime: 0});
  const shallowFrom = head > depth ? head - depth : 0n;

  const recent = await db.payment.findMany({
    where: {agentId: agent.id, status: "CONFIRMED", blockNumber: {not: null}},
    orderBy: {createdAt: "desc"},
    take: 50,
  });

  let updated = 0;
  for (const payment of recent) {
    // Блок глубже зоны реорга — перечитывать нечего. Блок «из будущего» (номер больше
    // головы) означает, что цепь укоротилась: такой платёж проверяем обязательно.
    const block = BigInt(payment.blockNumber!);
    if (block < shallowFrom && block <= head) {
      continue;
    }

    const found = await locate(payment);
    if (found) {
      continue; // операция на месте
    }

    await markReorged(payment);
    updated++;
  }

  return updated;
}

/** Ищет операцию платежа в сети: сначала по известному чеку, потом по логам EntryPoint. */
async function locate(payment: Payment): Promise<({txHash: Hex} & UserOperationOutcome) | null> {
  if (!payment.userOpHash) {
    return null;
  }

  if (payment.txHash) {
    try {
      const outcome = await readUserOperationOutcome(
        payment.txHash as Hex,
        payment.userOpHash as Hex,
      );
      if (outcome) {
        return {txHash: payment.txHash as Hex, ...outcome};
      }
    } catch {
      // Чека нет — транзакция могла быть вытеснена реоргом. Ищем операцию по логам.
    }
  }

  return findUserOperationByHash(payment.userOpHash as Hex);
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

  // Сверяем не только незавершённые: подтверждённый платёж тоже может «расподтвердиться»
  // после реорга, пока его блок не ушёл на глубину. Окончательные FAILED не трогаем.
  if (payment.status === "FAILED") {
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
