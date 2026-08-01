import {json, readJson, route} from "@/lib/api";
import {requireAgent} from "@/lib/auth";
import {invoiceView, issueInvoice, listInvoices} from "@/lib/invoices";
import {parseAddress, parseValue} from "@/lib/validate";

/**
 * Счета: платёж, инициированный получателем.
 *
 * Счёт — это просьба, а не право списать. Платит агент, и границы его кошелька действуют
 * как обычно; никакого «списания по счёту» в контракте нет.
 */

/** GET /api/v1/invoices — счета, выставленные этим агентом. */
export const GET = route(async (request) => {
  const agent = await requireAgent(request);

  return json({invoices: (await listInvoices(agent)).map(invoiceView)});
});

/**
 * POST /api/v1/invoices — выставить счёт.
 *
 * Тело: {"valueEth": "0.25", "memo": "подписка на API", "ttlSeconds": 3600, "to": "0x…"}
 * `to` по умолчанию — кошелёк выставившего агента.
 */
export const POST = route(async (request) => {
  const agent = await requireAgent(request);
  const body = await readJson<{
    valueWei?: unknown;
    valueEth?: unknown;
    memo?: unknown;
    ttlSeconds?: unknown;
    to?: unknown;
  }>(request);

  const invoice = await issueInvoice(agent, {
    valueWei: parseValue(body),
    to: body.to === undefined ? undefined : parseAddress(body.to, "to"),
    memo: body.memo === undefined ? undefined : String(body.memo),
    ttlSeconds: body.ttlSeconds === undefined ? undefined : Number(body.ttlSeconds),
  });

  return json(
    {
      ...invoiceView(invoice),
      payWith: {
        method: "POST",
        path: "/api/v1/agents/me/transactions",
        body: {invoiceId: invoice.id},
      },
    },
    {status: 201},
  );
});
