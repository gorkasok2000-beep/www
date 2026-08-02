import {json, route} from "@/lib/api";
import {requireAdmin} from "@/lib/auth";
import {deliverDue} from "@/lib/webhooks";

/**
 * POST /api/v1/admin/webhooks/flush — разобрать очередь повторов вручную.
 *
 * Отдельного воркера в прототипе нет: повторы подбираются попутно, при чтении платежей.
 * Значит, если агент перестал ходить в API, его недоставленные события зависли бы до
 * следующего визита. Эта ручка — честная замена планировщику: её же дёргает
 * `pnpm webhooks:flush`, и она же нужна, чтобы проверить повторы в тестах.
 *
 * Заголовок: X-API-Key: <ADMIN_API_TOKEN>
 */
export const POST = route(async (request) => {
  requireAdmin(request);

  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
  const result = await deliverDue(Number.isInteger(limit) && limit > 0 ? limit : 100);

  return json(result);
});
