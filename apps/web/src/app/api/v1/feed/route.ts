import {publicAgents, publicFeed} from "@/lib/agents";
import {json, route} from "@/lib/api";

/**
 * GET /api/v1/feed — публичная витрина: активные агенты и живая лента их трат.
 *
 * Данные анонимизированы: только публичное имя агента, усечённый адрес получателя
 * и сумма. Кто стоит за агентом — не наше дело и не наши данные.
 */
export const GET = route(async () => {
  const [agents, transactions] = await Promise.all([publicAgents(), publicFeed()]);
  return json({agents, transactions});
});
