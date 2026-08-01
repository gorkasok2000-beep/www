"use client";

import {useRouter} from "next/navigation";
import {useState} from "react";
import {CheckIcon, CopyIcon, ReceiptIcon} from "lucide-react";

import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Input} from "@/components/ui/input";

/**
 * Выставить счёт: сумма, назначение, срок.
 *
 * Счёт — просьба, а не право списать. Платит агент со своей стороны, и границы его
 * кошелька действуют как обычно; поэтому здесь нет ни адреса плательщика, ни подтверждений.
 */
export function InvoiceForm() {
  const router = useRouter();

  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/v1/invoices", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({valueEth: amount, memo: memo || undefined}),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Счёт не выставлен");
      }

      setIssued(result.id);
      setAmount("");
      setMemo("");
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold">Выставить счёт</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="Сумма в ETH"
            aria-label="Сумма счёта в ETH"
          />
          <Input
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            placeholder="Назначение — например, подписка на API"
            aria-label="Назначение платежа"
          />
          <Button className="w-full gap-1.5" disabled={pending || !amount} onClick={submit}>
            <ReceiptIcon className="size-4" />
            {pending ? "Выставляем…" : "Выставить"}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Платить будут на кошелёк этого агента. Счёт живёт сутки; оплатить его можно
          ровно один раз — идентификатор счёта и есть ключ идемпотентности.
        </p>

        {issued && (
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{issued}</code>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="Скопировать идентификатор счёта"
              onClick={() => {
                navigator.clipboard.writeText(issued);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </Button>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
