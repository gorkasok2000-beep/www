import {json, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {getPayment, paymentView} from "@/lib/payments";

/**
 * GET /api/v1/agents/me/payments/:id — состояние одного платежа.
 *
 * Незавершённый платёж перед ответом сверяется с блокчейном — по `txHash`, а если его
 * записать не успели, по `userOpHash`, который известен ещё до отправки операции.
 */
export const GET = route(
  async (request, context: {params: Promise<{id: string}>}) => {
    const agent = await requireAgent(request);
    const {id} = await context.params;

    return json(paymentView(await getPayment(agent, id)));
  },
);
