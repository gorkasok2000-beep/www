import type {Agent, Webhook, WebhookDelivery} from "@/generated/prisma";

import {decryptSecret, signWebhook} from "./crypto";
import {db} from "./db";
import {describeError, log} from "./log";

/**
 * Уведомления агента о событиях платформы.
 *
 * Зачем это вообще. Без вебхуков единственный способ узнать судьбу платежа — крутить
 * `GET /payments/:id`. С ненулевой глубиной подтверждений платёж закрывается не в ответе
 * на `POST`, а спустя несколько блоков; выставивший счёт вообще не узнал бы об оплате,
 * пока сам не спросит. Агент, который «принимает решение и выполняет его», не обязан
 * держать ради этого polling-цикл.
 *
 * Гарантия — «не менее одного раза» (at-least-once). Сеть и рестарты процесса делают
 * ровно-однократную доставку недостижимой без распределённой транзакции с потребителем,
 * поэтому выбор честный: лучше прислать дважды, чем потерять. Обратная сторона —
 * идемпотентность обязан обеспечить потребитель, и для этого у каждого события есть
 * неизменный `eventId` (заголовок `X-Synth-Event-Id`): повтор несёт тот же идентификатор.
 *
 * ОГРАНИЧЕНИЕ ПРОТОТИПА: отдельного воркера нет. Первая попытка идёт синхронно после
 * события, повторы подбираются при чтении платежей (`listPayments`) и по явному
 * `POST /api/v1/admin/webhooks/flush`. В проде здесь нужна очередь и отдельный процесс:
 * иначе повтор наступает лишь тогда, когда кто-то пришёл читать.
 */

/** Событие, которое платформа умеет присылать. */
export const WEBHOOK_EVENTS = [
  "ping",
  "payment.confirmed",
  "payment.failed",
  "payment.reorged",
  "invoice.paid",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Паузы перед повторами: 1с, 5с, 25с, 2м, 10м, 1ч. Растут быстро — упавший приёмник
 * не должен получать шквал попыток, — но первая почти мгновенна: чаще всего это
 * секундный сетевой сбой, а не поломка.
 */
const BACKOFF_MS = [1_000, 5_000, 25_000, 120_000, 600_000, 3_600_000];

/** После стольких попыток доставка признаётся неудавшейся и уходит в FAILED. */
const MAX_ATTEMPTS = BACKOFF_MS.length;

/** Приёмник не должен держать наш запрос дольше этого. */
const TIMEOUT_MS = 5_000;

/**
 * Создаёт доставки для подписок агента и сразу пробует отправить.
 *
 * Best-effort целиком: ошибка доставки не имеет права сломать то, из-за чего событие
 * возникло. Платёж уже прошёл или не прошёл в блокчейне — недоступный вебхук этого
 * не меняет и не должен превращаться в ошибку API.
 */
export async function emit(
  agent: Pick<Agent, "id">,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const hooks = await db.webhook.findMany({where: {agentId: agent.id, active: true}});
    const targets = hooks.filter((hook) => subscribed(hook, event));
    if (targets.length === 0) {
      return;
    }

    for (const hook of targets) {
      await deliver(hook, event, data);
    }
  } catch (error) {
    log.warn("webhook.emit_failed", {agentId: agent.id, event, error: describeError(error)});
  }
}

/**
 * Создаёт доставку конкретной подписке и сразу пробует отправить, минуя фильтр событий.
 *
 * Нужно для `ping`: проверка подписки обязана дойти и до того, кто подписан только на
 * `payment.confirmed`, — иначе «проверить эндпоинт» молча ничего бы не делало.
 */
export async function deliver(
  hook: Webhook,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<WebhookDelivery> {
  const delivery = await db.webhookDelivery.create({
    data: {
      webhookId: hook.id,
      eventId: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
      event,
      // Тело фиксируется в момент события: повтор через час обязан нести то же самое,
      // иначе подпись потребителя перестанет сходиться с содержимым.
      payload: JSON.stringify({event, data}),
    },
  });

  // Первая попытка — синхронно: обычный случай это доставка за десятки миллисекунд,
  // и ждать её в фоне незачем.
  await attempt(hook, delivery);

  return db.webhookDelivery.findUniqueOrThrow({where: {id: delivery.id}});
}

/** Пустой список событий у подписки означает «присылать все». */
function subscribed(hook: Webhook, event: WebhookEvent): boolean {
  let events: unknown;
  try {
    events = JSON.parse(hook.events);
  } catch {
    return true;
  }
  return !Array.isArray(events) || events.length === 0 || events.includes(event);
}

/**
 * Добирает просроченные доставки.
 *
 * Вызывается из `listPayments` (там же, где уже живёт сверка платежей) и из
 * `POST /api/v1/admin/webhooks/flush`. Берёт ограниченную пачку, чтобы фоновая работа
 * не растягивала обычный HTTP-запрос.
 */
export async function deliverDue(limit = 20): Promise<{delivered: number; failed: number}> {
  const due = await db.webhookDelivery.findMany({
    where: {status: "PENDING", nextAttemptAt: {lte: new Date()}},
    orderBy: {nextAttemptAt: "asc"},
    take: limit,
    include: {webhook: true},
  });

  let delivered = 0;
  let failed = 0;
  for (const record of due) {
    const {webhook, ...delivery} = record;
    if (await attempt(webhook, delivery)) {
      delivered++;
    } else {
      failed++;
    }
  }

  return {delivered, failed};
}

/**
 * Одна попытка доставки. Возвращает true, если приёмник ответил 2xx.
 *
 * Неудача не бросает исключение: вызывающий — фоновая работа, и падение здесь ничего
 * полезного не сообщает. Причина запоминается в `lastError`, чтобы агент видел, почему
 * его эндпоинт не получает события, не заглядывая в логи платформы.
 */
async function attempt(hook: Webhook, delivery: WebhookDelivery): Promise<boolean> {
  const attempts = delivery.attempts + 1;
  const body = delivery.payload;
  const timestamp = Math.floor(Date.now() / 1000);

  let error: string | null = null;
  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synth-event": delivery.event,
        "x-synth-event-id": delivery.eventId,
        "x-synth-signature": `t=${timestamp},v1=${signWebhook(
          decryptSecret(hook.secretCiphertext),
          timestamp,
          body,
        )}`,
      },
      body,
      // Редирект не следуем по той же причине, что и в chain/signer.ts: иначе
      // SSRF-проверку адреса можно обойти ответом 302 на внутренний хост.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.ok) {
      await db.webhookDelivery.update({
        where: {id: delivery.id},
        data: {status: "DELIVERED", attempts, lastError: null, deliveredAt: new Date()},
      });
      log.info("webhook.delivered", {
        webhookId: hook.id,
        eventId: delivery.eventId,
        event: delivery.event,
        attempts,
      });
      return true;
    }

    error = `HTTP ${response.status}`;
  } catch (cause) {
    error = describeError(cause);
  }

  // Попытки исчерпаны — дальше долбить приёмник бессмысленно. Запись остаётся в базе:
  // по ней видно, что событие было и что доставить его не удалось.
  const exhausted = attempts >= MAX_ATTEMPTS;
  await db.webhookDelivery.update({
    where: {id: delivery.id},
    data: {
      status: exhausted ? "FAILED" : "PENDING",
      attempts,
      lastError: error,
      nextAttemptAt: new Date(Date.now() + (BACKOFF_MS[attempts - 1] ?? 0)),
    },
  });

  log.warn(exhausted ? "webhook.failed" : "webhook.retry_scheduled", {
    webhookId: hook.id,
    eventId: delivery.eventId,
    event: delivery.event,
    attempts,
    error,
  });
  return false;
}

/** Представление подписки в API. Секрет не отдаётся: он показан один раз при создании. */
export function webhookView(hook: Webhook, stats?: {pending: number; delivered: number; failed: number}) {
  return {
    id: hook.id,
    url: hook.url,
    events: safeEvents(hook.events),
    active: hook.active,
    createdAt: hook.createdAt.toISOString(),
    deliveries: stats,
  };
}

function safeEvents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
