import {redirect} from "next/navigation";

import {InvoiceForm} from "@/components/app/invoice-form";
import {Badge} from "@/components/ui/badge";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {currentAgent} from "@/lib/auth";
import {formatEth, shortAddress, timeAgo} from "@/lib/format";
import {invoiceView, listInvoices} from "@/lib/invoices";
import {listPayments, paymentView} from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * Платежи и счета.
 *
 * Отличие от «Транзакций»: там публичный лог блокчейна — только то, что действительно
 * произошло. Здесь — попытки со стороны платформы, включая неудавшиеся, с причиной
 * отказа. Незавершённые платежи сверяются с сетью при открытии страницы.
 */
const STATUS: Record<string, {label: string; variant: "secondary" | "outline" | "destructive"}> = {
  created: {label: "создан", variant: "outline"},
  submitted: {label: "отправлен", variant: "outline"},
  confirmed: {label: "подтверждён", variant: "secondary"},
  failed: {label: "отклонён", variant: "destructive"},
};

const INVOICE_STATUS: Record<string, {label: string; variant: "secondary" | "outline" | "destructive"}> = {
  open: {label: "ожидает оплаты", variant: "outline"},
  paid: {label: "оплачен", variant: "secondary"},
  expired: {label: "просрочен", variant: "destructive"},
  cancelled: {label: "отменён", variant: "destructive"},
};

export default async function PaymentsPage() {
  const agent = await currentAgent();
  if (!agent) {
    redirect("/register");
  }

  const [payments, invoices] = await Promise.all([
    listPayments(agent).then((rows) => rows.map(paymentView)),
    listInvoices(agent).then((rows) => rows.map(invoiceView)),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Платежи</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Попытки оплаты со стороны агента — в том числе неудавшиеся, с причиной отказа.
          Повтор запроса с тем же ключом идемпотентности не создаёт вторую трату:
          в списке он останется одной записью.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-semibold">История платежей</CardTitle>
            </CardHeader>
            <CardContent>
              {payments.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  Платежей пока не было.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Получатель</TableHead>
                        <TableHead>Статус</TableHead>
                        <TableHead className="hidden md:table-cell">Когда</TableHead>
                        <TableHead className="text-right">Сумма</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((payment) => {
                        const status = STATUS[payment.status] ?? STATUS.created;
                        return (
                          <TableRow key={payment.id}>
                            <TableCell>
                              <span className="font-mono text-sm">{shortAddress(payment.to)}</span>
                              {payment.invoiceId && (
                                <span className="ml-2 text-xs text-muted-foreground">по счёту</span>
                              )}
                              {payment.failureReason && (
                                // whitespace-normal обязателен: ячейки таблицы не переносят
                                // строки, и причина отказа обрезалась бы на середине.
                                <p className="mt-1 max-w-md text-xs whitespace-normal text-muted-foreground">
                                  {payment.failureReason}
                                </p>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant={status.variant}>{status.label}</Badge>
                            </TableCell>
                            <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                              {timeAgo(payment.createdAt)}
                            </TableCell>
                            <TableCell className="text-right font-semibold tabular-nums">
                              {formatEth(payment.valueWei)} ETH
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-semibold">Выставленные счета</CardTitle>
            </CardHeader>
            <CardContent>
              {invoices.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Счетов пока нет. Выставьте первый — агенту достаточно будет его
                  идентификатора, чтобы заплатить.
                </p>
              ) : (
                <div className="divide-y">
                  {invoices.map((invoice) => {
                    const status = INVOICE_STATUS[invoice.status] ?? INVOICE_STATUS.open;
                    return (
                      <div key={invoice.id} className="flex items-center gap-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">
                            {invoice.memo ?? <span className="font-mono text-xs">{invoice.id}</span>}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {invoice.status === "paid"
                              ? `оплачен ${timeAgo(invoice.paidAt ?? invoice.createdAt)}`
                              : `до ${new Date(invoice.expiresAt).toLocaleString("ru-RU")}`}
                          </p>
                        </div>
                        <Badge variant={status.variant}>{status.label}</Badge>
                        <p className="shrink-0 text-sm font-semibold tabular-nums">
                          {formatEth(invoice.valueWei)} ETH
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <InvoiceForm />
      </div>
    </div>
  );
}
