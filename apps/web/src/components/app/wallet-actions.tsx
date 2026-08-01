"use client";

import {useRouter} from "next/navigation";
import {useState} from "react";
import {ArrowUpRightIcon, PlusIcon, TriangleAlertIcon} from "lucide-react";

import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Input} from "@/components/ui/input";

/**
 * Действия с кошельком: пополнение и отправка платежа.
 *
 * Обе кнопки бьют в тот же публичный API, которым пользуется агент, — интерфейс
 * не имеет приватных путей в обход правил.
 */
export function WalletActions({frozen}: {frozen: boolean}) {
  const router = useRouter();

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [depositAmount, setDepositAmount] = useState("1");
  const [pending, setPending] = useState<"send" | "deposit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function call(path: string, body: unknown, kind: "send" | "deposit") {
    setPending(kind);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Платёж требует ключа идемпотентности: двойной клик или повтор запроса
          // не должны превращаться во вторую трату. Ключ живёт ровно одну попытку —
          // после отказа кнопка создаёт новый.
          ...(kind === "send" ? {"idempotency-key": crypto.randomUUID()} : {}),
        },
        body: JSON.stringify(body),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Операция не выполнена");
      }

      setNotice(`Транзакция ${String(result.txHash).slice(0, 18)}…`);
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold">Действия</CardTitle>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Пополнить из тестового крана
          </p>
          <div className="flex gap-2">
            <Input
              value={depositAmount}
              onChange={(event) => setDepositAmount(event.target.value)}
              inputMode="decimal"
              placeholder="1"
              aria-label="Сумма пополнения в ETH"
            />
            <Button
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={pending !== null}
              onClick={() => call("/api/v1/agents/me/deposit", {valueEth: depositAmount}, "deposit")}
            >
              <PlusIcon className="size-4" />
              {pending === "deposit" ? "…" : "ETH"}
            </Button>
          </div>
        </div>

        <div className="space-y-3 border-t pt-6">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Отправить платёж
          </p>
          <Input
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="0x… адрес получателя"
            className="font-mono text-sm"
            aria-label="Адрес получателя"
          />
          <div className="flex gap-2">
            <Input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.05"
              aria-label="Сумма в ETH"
            />
            <Button
              className="shrink-0 gap-1.5"
              disabled={pending !== null || frozen || !to || !amount}
              onClick={() =>
                call("/api/v1/agents/me/transactions", {to, valueEth: amount}, "send")
              }
            >
              <ArrowUpRightIcon className="size-4" />
              {pending === "send" ? "Отправляем…" : "Отправить"}
            </Button>
          </div>
          {frozen && (
            <p className="text-xs text-muted-foreground">
              Кошелёк заморожен — траты недоступны до разморозки администратором.
            </p>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
        {notice && <p className="font-mono text-xs text-muted-foreground">{notice}</p>}
      </CardContent>
    </Card>
  );
}
