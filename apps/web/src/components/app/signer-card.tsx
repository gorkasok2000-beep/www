"use client";

import {useRouter} from "next/navigation";
import {useState} from "react";
import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  ServerIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Input} from "@/components/ui/input";
import {Progress} from "@/components/ui/progress";
import {formatEth, shortAddress} from "@/lib/format";

/**
 * Чем платформа подписывает операции этого кошелька — и в каких границах.
 *
 * До сих пор это было видно только из кода. Между тем это главный вопрос доверия:
 * держит ли платформа главный ключ агента или всего лишь ключ с бюджетом, который
 * владелец в любой момент отзовёт.
 */

type SessionKey = {
  address: string;
  budgetWei: string;
  spentWei: string;
  remainingWei: string;
  validUntil: string;
  targetsRestricted: boolean;
  registered: boolean;
};

type PendingTransaction = {to: string; data: string};

const MODE: Record<string, {label: string; icon: React.ElementType; hint: string}> = {
  SERVER_KEY: {
    label: "Главный ключ на сервере",
    icon: ServerIcon,
    hint: "Прототипный режим: платформа подписывает главным ключом агента и может потратить всё. Выпустите ключ с бюджетом — и она перестанет им пользоваться.",
  },
  SESSION_KEY: {
    label: "Ключ с бюджетом",
    icon: KeyRoundIcon,
    hint: "Главный ключ у агента. Платформа платит выданным ключом и не может выйти за его границы.",
  },
  REMOTE: {
    label: "Подпись у агента",
    icon: ShieldCheckIcon,
    hint: "Ключа у платформы нет вовсе: хеш операции уходит агенту, тот возвращает подпись.",
  },
};

export function SignerCard({
  mode,
  signerUrl,
  sessionKey,
}: {
  mode: string;
  signerUrl: string | null;
  sessionKey: SessionKey | null;
}) {
  const router = useRouter();

  const [budget, setBudget] = useState("0.5");
  const [pending, setPending] = useState<"issue" | "revoke" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<PendingTransaction | null>(null);

  const meta = MODE[mode] ?? MODE.SERVER_KEY;
  const Icon = meta.icon;

  async function call(method: string, body: unknown, kind: "issue" | "revoke" | "confirm") {
    setPending(kind);
    setError(null);

    try {
      const response = await fetch("/api/v1/agents/me/session-keys" + (kind === "confirm" ? "/confirm" : ""), {
        method,
        headers: {"content-type": "application/json"},
        body: body ? JSON.stringify(body) : undefined,
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Не получилось");
      }

      // Если главного ключа у платформы нет, она возвращает транзакцию — её отправляет
      // владелец сам, своим ключом. Показываем её как есть.
      setTransaction(result.transaction ?? null);
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(null);
    }
  }

  const used =
    sessionKey && BigInt(sessionKey.budgetWei) > 0n
      ? Number((BigInt(sessionKey.spentWei) * 100n) / BigInt(sessionKey.budgetWei))
      : 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="text-base font-semibold">Подпись операций</CardTitle>
        <Badge variant={mode === "SERVER_KEY" ? "outline" : "secondary"} className="gap-1">
          <Icon className="size-3" />
          {meta.label}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">{meta.hint}</p>

        {signerUrl && (
          <p className="truncate font-mono text-xs text-muted-foreground">{signerUrl}</p>
        )}

        {sessionKey && sessionKey.registered && (
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-sm">{shortAddress(sessionKey.address)}</span>
              <span className="text-xs text-muted-foreground">
                до {new Date(sessionKey.validUntil).toLocaleString("ru-RU")}
              </span>
            </div>

            <Progress value={used} className="h-2" />

            <div className="flex items-center justify-between text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Потрачено</p>
                <p className="font-semibold tabular-nums">{formatEth(sessionKey.spentWei)} ETH</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Осталось платформе</p>
                <p className="font-semibold tabular-nums">
                  {formatEth(sessionKey.remainingWei)} ETH
                </p>
              </div>
            </div>

            {sessionKey.targetsRestricted && (
              <p className="text-xs text-muted-foreground">
                Ключ ограничен списком получателей.
              </p>
            )}

            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={pending !== null}
              onClick={() => call("DELETE", null, "revoke")}
            >
              {pending === "revoke" ? "Отзываем…" : "Отозвать ключ"}
            </Button>
          </div>
        )}

        {sessionKey && !sessionKey.registered && (
          <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div className="space-y-2">
              <p>Ключ выпущен, но ещё не зарегистрирован в кошельке.</p>
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => call("POST", null, "confirm")}
              >
                {pending === "confirm" ? "Проверяем…" : "Проверить регистрацию"}
              </Button>
            </div>
          </div>
        )}

        {transaction && (
          <div className="space-y-2 rounded-lg border p-4">
            <p className="text-sm font-medium">Отправьте эту транзакцию ключом владельца</p>
            <p className="text-xs text-muted-foreground">
              Зарегистрировать ключ вправе только владелец кошелька — платформа этого
              сделать не может.
            </p>
            <CopyRow label="Кому" value={transaction.to} />
            <CopyRow label="Данные" value={transaction.data} />
          </div>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium">
            {sessionKey?.registered ? "Выпустить новый ключ" : "Выдать платформе ключ"}
          </p>
          <div className="flex gap-2">
            <Input
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              inputMode="decimal"
              placeholder="0.5"
              aria-label="Бюджет ключа в ETH"
            />
            <Button
              className="shrink-0"
              disabled={pending !== null || !budget}
              onClick={() => call("POST", {budgetEth: budget, ttlSeconds: 86400}, "issue")}
            >
              {pending === "issue" ? "Выпускаем…" : "Выпустить"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Бюджет в ETH на сутки. Предыдущий ключ будет отозван.
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function CopyRow({label, value}: {label: string; value: string}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={() => {
          navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={`Скопировать: ${label}`}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
