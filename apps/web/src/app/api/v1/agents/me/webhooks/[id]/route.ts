import {json, route} from "@/lib/api";
import {AgentError} from "@/lib/agent-error";
import {requireAgent} from "@/lib/auth";
import {db} from "@/lib/db";

/**
 * DELETE /api/v1/agents/me/webhooks/:id — отписаться.
 *
 * Подписка удаляется вместе с историей доставок (каскад в схеме): держать журнал
 * доставок на несуществующий адрес незачем.
 */
export const DELETE = route(async (request, context: {params: Promise<{id: string}>}) => {
  const agent = await requireAgent(request);
  const {id} = await context.params;

  // deleteMany с условием на agentId, а не delete по id: чужую подписку удалять нельзя,
  // и по ответу не должно быть видно, существует ли она вообще.
  const removed = await db.webhook.deleteMany({where: {id, agentId: agent.id}});
  if (removed.count === 0) {
    throw new AgentError(`Подписка ${id} не найдена.`, 404);
  }

  return json({status: "deleted", id});
});
