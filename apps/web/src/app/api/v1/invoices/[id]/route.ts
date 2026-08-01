import {json, route} from "@/lib/api";
import {invoiceView, readInvoice} from "@/lib/invoices";

/**
 * GET /api/v1/invoices/:id — прочитать счёт.
 *
 * Без API-ключа: счёт адресован тому, кто будет платить, и он не обязан быть
 * зарегистрирован у нас. Ничего приватного здесь нет — сумма, адрес и назначение
 * и так предъявляются плательщику.
 */
export const GET = route(async (_request, context: {params: Promise<{id: string}>}) => {
  const {id} = await context.params;

  return json(invoiceView(await readInvoice(id)));
});
