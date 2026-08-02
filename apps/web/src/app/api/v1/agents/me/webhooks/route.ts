import {json, readJson, route} from "@/lib/api";
import {AgentError} from "@/lib/agent-error";
import {requireAgent} from "@/lib/auth";
import {encryptSecret, generateWebhookSecret} from "@/lib/crypto";
import {db} from "@/lib/db";
import {assertResolvesPublic, parseCallbackUrl} from "@/lib/validate";
import {WEBHOOK_EVENTS, webhookView, type WebhookEvent} from "@/lib/webhooks";

/**
 * Подписки агента на события платформы.
 *
 * Альтернатива опросу `GET /payments/:id`: с ненулевой глубиной подтверждений платёж
 * закрывается через несколько блоков после ответа на `POST`, а получатель счёта об
 * оплате вообще не узнал бы, пока не спросил сам.
 */

/** GET /api/v1/agents/me/webhooks — подписки и счётчики доставок. */
export const GET = route(async (request) => {
  const agent = await requireAgent(request);

  const hooks = await db.webhook.findMany({
    where: {agentId: agent.id},
    orderBy: {createdAt: "desc"},
  });

  const views = [];
  for (const hook of hooks) {
    const grouped = await db.webhookDelivery.groupBy({
      by: ["status"],
      where: {webhookId: hook.id},
      _count: {_all: true},
    });
    const count = (status: string) =>
      grouped.find((row) => row.status === status)?._count._all ?? 0;

    views.push(
      webhookView(hook, {
        pending: count("PENDING"),
        delivered: count("DELIVERED"),
        failed: count("FAILED"),
      }),
    );
  }

  return json({webhooks: views, availableEvents: WEBHOOK_EVENTS});
});

/**
 * POST /api/v1/agents/me/webhooks — подписаться.
 *
 * Тело: {"url": "https://…", "events": ["payment.confirmed"]}
 * Пустой или отсутствующий `events` означает «присылать все».
 *
 * Секрет подписки возвращается ОДИН раз: платформа хранит его зашифрованным и показать
 * второй раз не сможет. Без секрета потребитель не отличит наш запрос от чужого —
 * адрес эндпоинта не тайна.
 */
export const POST = route(async (request) => {
  const agent = await requireAgent(request);
  const body = await readJson<{url?: unknown; events?: unknown}>(request);

  // Та же проверка от SSRF, что и для signerUrl: запрос уходит с нашего сервера, и без
  // фильтра подписка стала бы способом читать внутреннюю сеть через платформу.
  const url = parseCallbackUrl(body.url, "url");
  if (!url) {
    throw new AgentError("Укажите url — адрес, куда присылать события.", 400);
  }
  await assertResolvesPublic(url, "url");

  const events = parseEvents(body.events);

  const secret = generateWebhookSecret();
  const hook = await db.webhook.create({
    data: {
      agentId: agent.id,
      url,
      secretCiphertext: encryptSecret(secret),
      events: JSON.stringify(events),
    },
  });

  return json(
    {
      ...webhookView(hook),
      secret,
      note:
        "Сохраните secret: он показывается один раз. Подпись приходит в заголовке " +
        "X-Synth-Signature: t=<unix>,v1=<hmac-sha256(secret, t + \".\" + body)>.",
    },
    {status: 201},
  );
});

/** Имена событий проверяем на входе: опечатка иначе тихо отписала бы агента от всего. */
function parseEvents(value: unknown): WebhookEvent[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AgentError("Поле events должно быть массивом строк.", 400);
  }

  return value.map((entry) => {
    if (typeof entry !== "string" || !WEBHOOK_EVENTS.includes(entry as WebhookEvent)) {
      throw new AgentError(
        `Неизвестное событие «${String(entry)}». Доступны: ${WEBHOOK_EVENTS.join(", ")}.`,
        400,
      );
    }
    return entry as WebhookEvent;
  });
}
