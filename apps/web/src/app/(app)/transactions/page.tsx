import {redirect} from "next/navigation";

import {Card, CardContent} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {agentTransactions} from "@/lib/agents";
import {currentAgent} from "@/lib/auth";
import {formatEth, shortAddress} from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const agent = await currentAgent();
  if (!agent) {
    redirect("/register");
  }

  const transactions = await agentTransactions(agent, 100);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Транзакции</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Публичный лог кошелька: кто, когда, сколько и кому. Данные читаются из событий
          контракта, а не из внутренней базы.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          {transactions.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              История пуста. Первая трата появится здесь автоматически.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Получатель</TableHead>
                    <TableHead className="hidden md:table-cell">Транзакция</TableHead>
                    <TableHead className="hidden sm:table-cell">Блок</TableHead>
                    <TableHead>Время</TableHead>
                    <TableHead className="text-right">Сумма</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transactions.map((tx) => (
                    <TableRow key={`${tx.txHash}-${tx.logIndex}`}>
                      <TableCell className="font-mono text-sm">{shortAddress(tx.to)}</TableCell>
                      <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                        {shortAddress(tx.txHash)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums text-muted-foreground sm:table-cell">
                        {tx.blockNumber}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {tx.timestamp.toLocaleString("ru-RU")}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatEth(tx.valueWei)} ETH
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
