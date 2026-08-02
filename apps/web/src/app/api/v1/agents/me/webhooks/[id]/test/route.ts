import {json, route} from "@/lib/api";
import {AgentError} from "@/lib/agent-error";
import {requireAgent} from "@/lib/auth";
import {db} from "@/lib/db";
import {deliver} from "@/lib/webhooks";

/**
 * POST /api/v1/agents/me/webhooks/:id/test — послать `ping`.
 *
 * Проверка «работает ли вообще»: адрес доступен, подпись сходится, обработчик отвечает
 * 2xx. Без неё первую доставку агент увидел бы только на настоящем платеже — то есть
 * узнал бы об ошибке в конфигурации ровно тогда, когда она мешает.
 */
export const POST = route(async (request, context: {params: Promise<{id: string}>}) => {
  const agent = await requireAgent(request);
  const {id} = await context.params;

  const hook = await db.webhook.findFirst({where: {id, agentId: agent.id}});
  if (!hook) {
    throw new AgentError(`Подписка ${id} не найдена.`, 404);
  }

  // deliver создаёт доставку и сразу пробует отправить, поэтому итог первой попытки уже
  // записан — читаем его и показываем агенту.
  const delivery = await deliver(hook, "ping", {
    agentId: agent.id,
    webhookId: hook.id,
    sentAt: new Date().toISOString(),
  });

  return json({
    status: delivery.status.toLowerCase(),
    eventId: delivery.eventId,
    attempts: delivery.attempts,
    lastError: delivery.lastError,
  });
});
