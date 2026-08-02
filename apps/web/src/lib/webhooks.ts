import {createHmac, randomBytes} from "node:crypto";

import type {Agent, WebhookDelivery} from "@/generated/prisma";

import {decryptSecret} from "./crypto";
import {db} from "./db";
import {describeError, log} from "./log";

/**
 * Вебхуки: уведомления агента о смене состояния его платежей и счетов.
 *
 * Агент — программа, и поллинг `GET /payments/<id>` для него лишняя работа: о том,
 * что платёж подтвердился, проще узнать событием. Устройство доставки:
 *
 *   - at-least-once. Событие СНАЧАЛА пишется в базу, потом отправляется. Эндпоинт
 *     ответил не 2xx или недоступен — доставка остаётся PENDING и повторяется с
 *     backoff'ом, пока не исчерпает попытки. Поэтому агент обязан быть готов к
 *     повторам;
 *   - идемпотентность — на стороне агента. У каждой доставки свой id (заголовок
 *     `x-synth-delivery`), по нему повтор отсекается;
 *   - подлинность — HMAC-SHA256 тела на секрете, выданном агенту при регистрации
 *     (заголовок `x-synth-signature: sha256=<hex>`). Без подписи любой, кто знает
 *     URL эндпоинта, мог бы «подтвердить» чужой платёж;
 *   - адрес проверяется так же, как signerUrl: приватные диапазоны запрещены,
 *     редиректы не обслуживаются.
 *
 * Первую попытку делаем сразу, не дожидаясь очереди; повторы крутятся из
 * `processWebhookQueue`, который вызывается при активности агента (сверка платежей).
 * Отдельный воркер — задача продакшена, как и воркер сверки.
 */

export type WebhookEvent =
  | "payment.confirmed"
  | "payment.failed"
  | "payment.reorged"
  | "invoice.paid";

/** Сколько раз пытаемся доставить, прежде чем признать доставку FAILED. */
const MAX_ATTEMPTS = 8;

/** Таймаут одной попытки: вебхук не имеет права подвешивать платёжный запрос. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** Секрет подписи вебхуков. Показывается агенту один раз, в базе лежит зашифрованным. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/** Подпись тела доставки — агент сверяет её своей копией секрета. */
export function signWebhookPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Ставит событие в очередь и сразу делает первую попытку доставки.
 *
 * Никогда не бросает: уведомление — вторичный канал, оно не имеет права ломать
 * платёж, о котором уведомляет. Правда о состоянии — в API и в базе.
 */
export async function enqueueWebhook(
  agentId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const agent = await db.agent.findUnique({where: {id: agentId}});
    if (!agent?.webhookUrl || !agent.webhookSecretCiphertext) {
      return;
    }

    // id генерируем сами, а не полагаемся на default(cuid()): он нужен заранее,
    // чтобы попасть в тело доставки (по нему агент отсекает повторы).
    const id = `whd_${randomBytes(12).toString("hex")}`;
    const payload = JSON.stringify({id, event, createdAt: new Date().toISOString(), data});

    const delivery = await db.webhookDelivery.create({
      data: {id, agentId, event, payload},
    });

    await deliver(delivery, agent);
  } catch (error) {
    log.warn("webhook.enqueue_failed", {agentId, event, error: describeError(error)});
  }
}

/**
 * Повторяет доставки, чьё время пришло. Вызывается при активности агента
 * (сверка платежей) — отдельного воркера в прототипе нет.
 */
export async function processWebhookQueue(limit = 10): Promise<number> {
  const due = await db.webhookDelivery.findMany({
    where: {status: "PENDING", nextAttemptAt: {lte: new Date()}},
    orderBy: {nextAttemptAt: "asc"},
    take: limit,
  });

  for (const delivery of due) {
    const agent = await db.agent.findUnique({where: {id: delivery.agentId}});
    if (!agent?.webhookUrl || !agent.webhookSecretCiphertext) {
      // Эндпоинт сняли — повторять больше незачем.
      await db.webhookDelivery.update({where: {id: delivery.id}, data: {status: "FAILED"}});
      continue;
    }
    await deliver(delivery, agent);
  }

  return due.length;
}

/** Одна попытка доставки. Исход фиксируется в базе: 2xx — DELIVERED, иначе повтор. */
async function deliver(delivery: WebhookDelivery, agent: Agent): Promise<void> {
  const signature = signWebhookPayload(
    decryptSecret(agent.webhookSecretCiphertext!),
    delivery.payload,
  );

  let responseStatus: number | null = null;
  try {
    const response = await fetch(agent.webhookUrl!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synth-delivery": delivery.id,
        "x-synth-event": delivery.event,
        "x-synth-signature": `sha256=${signature}`,
      },
      body: delivery.payload,
      // Редиректы не обслуживаем — тот же довод, что и у signerUrl: иначе проверку
      // адреса при регистрации обходят ответом 302 на внутренний хост.
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    responseStatus = response.status;

    if (response.ok) {
      await db.webhookDelivery.update({
        where: {id: delivery.id},
        data: {status: "DELIVERED", attempts: {increment: 1}, responseStatus, deliveredAt: new Date()},
      });
      log.info("webhook.delivered", {agentId: agent.id, event: delivery.event, status: responseStatus});
      return;
    }
  } catch (error) {
    log.warn("webhook.attempt_failed", {agentId: agent.id, event: delivery.event, error: describeError(error)});
  }

  await scheduleRetry(delivery, responseStatus);
}

/** Планирует повтор с backoff'ом либо хоронит доставку после последней попытки. */
async function scheduleRetry(delivery: WebhookDelivery, responseStatus: number | null): Promise<void> {
  const attempts = delivery.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db.webhookDelivery.update({
      where: {id: delivery.id},
      data: {status: "FAILED", attempts, responseStatus},
    });
    log.warn("webhook.gave_up", {agentId: delivery.agentId, event: delivery.event, status: responseStatus ?? "no-response"});
    return;
  }

  // 1, 2, 4, … 128 минут: быстрые повторы ловят краткий сбой, длинные — простой эндпоинта.
  const delayMs = 2 ** Math.min(attempts - 1, 7) * 60 * 1000;
  await db.webhookDelivery.update({
    where: {id: delivery.id},
    data: {attempts, responseStatus, nextAttemptAt: new Date(Date.now() + delayMs)},
  });
}
