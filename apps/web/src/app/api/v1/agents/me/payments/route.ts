import {json, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {listPayments, paymentView} from "@/lib/payments";

/**
 * GET /api/v1/agents/me/payments — платежи агента со статусами.
 *
 * Здесь же происходит сверка незавершённых платежей с блокчейном: если ответ на оплату
 * не дошёл до агента, он приходит сюда и узнаёт, чем всё кончилось на самом деле.
 * Правду даёт сеть, а не эта таблица.
 */
export const GET = route(async (request) => {
  const agent = await requireAgent(request);
  const payments = await listPayments(agent);

  return json({
    account: agent.accountAddress,
    payments: payments.map(paymentView),
  });
});
