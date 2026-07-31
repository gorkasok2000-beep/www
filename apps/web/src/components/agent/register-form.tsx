"use client";

import {useRouter} from "next/navigation";
import {useState} from "react";
import {BotIcon, CheckIcon, CopyIcon, TriangleAlertIcon, UserRoundIcon} from "lucide-react";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent} from "@/components/ui/card";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {cn} from "@/lib/utils";

type Mode = "HUMAN_CUSTODIAN" | "AUTONOMOUS_ENTITY";

type Created = {
  handle: string;
  mode: Mode;
  account: string;
  apiKey: string;
};

const PERIODS = [
  {value: 0, label: "за транзакцию"},
  {value: 3600, label: "в час"},
  {value: 86400, label: "в сутки"},
  {value: 604800, label: "в неделю"},
];

/**
 * Флоу регистрации: выбор сценария → настройки → выдача ключа.
 *
 * Правила показываются только для Human Custodian — у автономного агента их не
 * существует и на уровне контракта, так что скрывать их в UI честно, а не косметически.
 */
export function RegisterForm() {
  const router = useRouter();

  const [mode, setMode] = useState<Mode | null>(null);
  const [handle, setHandle] = useState("");
  const [limitEth, setLimitEth] = useState("");
  const [periodSeconds, setPeriodSeconds] = useState(86400);
  const [whitelistEnabled, setWhitelistEnabled] = useState(false);
  const [whitelist, setWhitelist] = useState("");

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  async function submit() {
    if (!mode) return;

    setPending(true);
    setError(null);

    const rules =
      mode === "HUMAN_CUSTODIAN"
        ? {
            limitEth: limitEth.trim() || "0",
            periodSeconds,
            whitelistEnabled,
          }
        : undefined;

    const addresses = whitelist
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    try {
      const response = await fetch("/api/v1/agents", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          handle: handle.trim(),
          mode,
          rules,
          whitelist: mode === "HUMAN_CUSTODIAN" ? addresses : [],
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? "Не удалось создать кошелёк");
      }

      setCreated(body as Created);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  }

  if (created) {
    return <CreatedCard created={created} onOpenDashboard={() => router.push("/dashboard")} />;
  }

  return (
    <div className="space-y-10">
      <div className="grid gap-4 md:grid-cols-2">
        <ModeCard
          selected={mode === "HUMAN_CUSTODIAN"}
          onSelect={() => setMode("HUMAN_CUSTODIAN")}
          icon={<UserRoundIcon className="size-5 text-muted-foreground" />}
          badge="Human Custodian"
          title="Я создаю кошелёк своему агенту"
          text="Можно задать лимит трат и список разрешённых получателей. Правила меняются в любой момент — тратить за агента вы не сможете."
        />
        <ModeCard
          selected={mode === "AUTONOMOUS_ENTITY"}
          onSelect={() => setMode("AUTONOMOUS_ENTITY")}
          icon={<BotIcon className="size-5 text-muted-foreground" />}
          badge="Autonomous Entity"
          title="Кошелёк принадлежит самому агенту"
          text="Никаких проверок и ограничений по умолчанию. Кастодиана нет, поэтому правила недоступны — так задумано."
        />
      </div>

      {mode && (
        <div className="space-y-8">
          <div className="space-y-2">
            <label htmlFor="handle" className="text-sm font-medium">
              Публичное имя агента
            </label>
            <Input
              id="handle"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="orion"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Под этим именем агент появится в публичной витрине. Латиница, цифры и дефис.
            </p>
          </div>

          {mode === "HUMAN_CUSTODIAN" && (
            <div className="space-y-6 rounded-xl border p-6">
              <div>
                <h3 className="text-sm font-medium">Правила трат</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Необязательны. Пустой лимит означает «без ограничения».
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="limit" className="text-sm">
                    Лимит, ETH
                  </label>
                  <Input
                    id="limit"
                    inputMode="decimal"
                    value={limitEth}
                    onChange={(event) => setLimitEth(event.target.value)}
                    placeholder="0.5"
                  />
                </div>

                <div className="space-y-2">
                  <span className="text-sm">Период</span>
                  <div className="flex flex-wrap gap-2">
                    {PERIODS.map((period) => (
                      <Button
                        key={period.value}
                        type="button"
                        size="sm"
                        variant={periodSeconds === period.value ? "default" : "outline"}
                        onClick={() => setPeriodSeconds(period.value)}
                      >
                        {period.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex items-start justify-between gap-4 border-t pt-6">
                <div>
                  <p className="text-sm">Только разрешённые получатели</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Агент сможет платить исключительно адресам из whitelist.
                  </p>
                </div>
                <Switch checked={whitelistEnabled} onCheckedChange={setWhitelistEnabled} />
              </div>

              {whitelistEnabled && (
                <div className="space-y-2">
                  <label htmlFor="whitelist" className="text-sm">
                    Адреса через запятую или с новой строки
                  </label>
                  <textarea
                    id="whitelist"
                    value={whitelist}
                    onChange={(event) => setWhitelist(event.target.value)}
                    rows={3}
                    placeholder="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
                    className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <Button size="lg" disabled={pending || handle.trim().length < 2} onClick={submit}>
            {pending ? "Создаём кошелёк…" : "Создать кошелёк"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ModeCard({
  selected,
  onSelect,
  icon,
  badge,
  title,
  text,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  badge: string;
  title: string;
  text: string;
}) {
  return (
    <button type="button" onClick={onSelect} className="text-left">
      <Card
        className={cn(
          "h-full transition-colors",
          selected ? "border-foreground/40 bg-muted/40" : "border-border/60 hover:border-border",
        )}
      >
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
              {icon}
            </div>
            <Badge variant={selected ? "default" : "secondary"}>{badge}</Badge>
          </div>
          <h3 className="mt-5 font-medium">{title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
        </CardContent>
      </Card>
    </button>
  );
}

function CreatedCard({created, onOpenDashboard}: {created: Created; onOpenDashboard: () => void}) {
  const [copied, setCopied] = useState(false);

  return (
    <Card>
      <CardContent className="space-y-8 pt-6">
        <div>
          <Badge variant="secondary">Кошелёк создан</Badge>
          <h2 className="mt-4 text-2xl font-medium tracking-tight">{created.handle}</h2>
          <p className="mt-2 break-all font-mono text-sm text-muted-foreground">
            {created.account}
          </p>
        </div>

        <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
          <p className="text-sm font-medium">API-ключ агента</p>
          <p className="text-xs text-muted-foreground">
            Показывается один раз. Сохраните его: восстановить ключ невозможно, только
            создать новый кошелёк.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-3 py-2 font-mono text-xs">
              {created.apiKey}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                navigator.clipboard.writeText(created.apiKey);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              {copied ? "Скопировано" : "Копировать"}
            </Button>
          </div>
        </div>

        <div className="rounded-xl border bg-muted/30 p-5">
          <p className="text-sm text-muted-foreground">Первая трата агента:</p>
          <pre className="mt-3 overflow-x-auto font-mono text-xs leading-relaxed">
            <code>{`curl -X POST /api/v1/agents/me/transactions \\
  -H "X-API-Key: ${created.apiKey.slice(0, 20)}…" \\
  -d '{"to": "0x…", "valueEth": "0.05"}'`}</code>
          </pre>
        </div>

        <Button size="lg" onClick={onOpenDashboard}>
          Открыть дашборд
        </Button>
      </CardContent>
    </Card>
  );
}
