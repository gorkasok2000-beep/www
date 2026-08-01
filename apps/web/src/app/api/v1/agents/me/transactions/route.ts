import type {Address} from "viem";

import {agentTransactions} from "@/lib/agents";
import {json, readJson, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {requirePayableInvoice} from "@/lib/invoices";
import {payWithIdempotency, paymentView} from "@/lib/payments";
import {parseAddress, parseIdempotencyKey, parseValue} from "@/lib/validate";

/**
 * GET /api/v1/agents/me/transactions — история трат кошелька (из публичного лога).
 */
export const GET = route(async (request) => {
  const agent = await requireAgent(request);
  const transactions = await agentTransactions(agent);

  return json({
    account: agent.accountAddress,
    transactions: transactions.map((tx) => ({
      to: tx.to,
      valueWei: tx.valueWei,
      selector: tx.selector,
      txHash: tx.txHash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp.toISOString(),
    })),
  });
});

/**
 * POST /api/v1/agents/me/transactions — агент инициирует оплату сам.
 *
 * Это ключевой эндпоинт ТЗ: ИИ-агент принимает решение о трате и выполняет её одним
 * HTTP-запросом. Разрешение спрашивать не у кого — ограничения уже записаны в контракт,
 * и если трата их нарушает, транзакция откатывается на уровне блокчейна.
 *
 * Заголовок `Idempotency-Key` обязателен: агент ретраит сам, по своей логике, и без
 * ключа повторный запрос стал бы вторым платежом. С ключом повтор возвращает первый
 * результат и ничего не отправляет; тот же ключ с другим телом — 409.
 *
 * Тело: {"to": "0x…", "valueEth": "0.05"}  либо  {"to": "0x…", "valueWei": "50000…"}
 * Необязательное поле `data` — calldata, если агент вызывает метод контракта.
 *
 * Оплата по счёту: {"invoiceId": "…"}. Сумма и получатель берутся из счёта, а заголовок
 * можно не передавать — ключом служит сам счёт, поэтому вторая оплата вернёт первую.
 */
export const POST = route(async (request) => {
  const agent = await requireAgent(request);
  const body = await readJson<{
    to?: unknown;
    valueWei?: unknown;
    valueEth?: unknown;
    data?: string;
    invoiceId?: unknown;
  }>(request);

  const input = body.invoiceId
    ? await fromInvoice(String(body.invoiceId), request)
    : {
        idempotencyKey: parseIdempotencyKey(request),
        to: parseAddress(body.to, "to"),
        valueWei: parseValue(body),
        data: (body.data as `0x${string}` | undefined) ?? "0x",
      };

  const {payment, replayed} = await payWithIdempotency(agent, input);

  return json({...paymentView(payment), replayed}, {status: replayed ? 200 : 201});
});

async function fromInvoice(invoiceId: string, request: Request) {
  const invoice = await requirePayableInvoice(invoiceId);

  return {
    // Явный заголовок уважаем, если он есть; иначе ключом служит сам счёт.
    idempotencyKey: request.headers.get("idempotency-key")?.trim() || `invoice:${invoice.id}`,
    to: invoice.to as Address,
    valueWei: BigInt(invoice.valueWei),
    data: "0x" as const,
    invoiceId: invoice.id,
  };
}
