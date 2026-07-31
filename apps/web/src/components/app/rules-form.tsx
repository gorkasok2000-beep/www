"use client";

import {useRouter} from "next/navigation";
import {useState} from "react";
import {CheckIcon, TriangleAlertIcon} from "lucide-react";

import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";

const PERIODS = [
  {value: 0, label: "за транзакцию"},
  {value: 3600, label: "в час"},
  {value: 86400, label: "в сутки"},
  {value: 604800, label: "в неделю"},
];

/**
 * Форма правил для кастодиана.
 *
 * Каждое сохранение — реальная транзакция от имени кастодиана: правила живут в
 * контракте, а не в настройках приложения, поэтому «сохранить» здесь означает
 * «подписать и отправить».
 */
export function RulesForm({
  initialLimitEth,
  initialPeriodSeconds,
  initialWhitelistEnabled,
}: {
  initialLimitEth: string;
  initialPeriodSeconds: number;
  initialWhitelistEnabled: boolean;
}) {
  const router = useRouter();

  const [limitEth, setLimitEth] = useState(initialLimitEth);
  const [periodSeconds, setPeriodSeconds] = useState(initialPeriodSeconds);
  const [whitelistEnabled, setWhitelistEnabled] = useState(initialWhitelistEnabled);

  const [target, setTarget] = useState("");
  const [pending, setPending] = useState<"rules" | "whitelist" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(kind: "rules" | "whitelist", init: RequestInit) {
    setPending(kind);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch("/api/v1/agents/me/rules", {
        headers: {"content-type": "application/json"},
        ...init,
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? "Не удалось сохранить");
      }

      setSaved(true);
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold">Лимит трат</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="limit" className="text-sm">
                Лимит, ETH (0 — без ограничения)
              </label>
              <Input
                id="limit"
                inputMode="decimal"
                value={limitEth}
                onChange={(event) => setLimitEth(event.target.value)}
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
                Платежи вне whitelist откатываются контрактом.
              </p>
            </div>
            <Switch checked={whitelistEnabled} onCheckedChange={setWhitelistEnabled} />
          </div>

          <Button
            disabled={pending !== null}
            onClick={() =>
              save("rules", {
                method: "PUT",
                body: JSON.stringify({
                  limitEth: limitEth.trim() || "0",
                  periodSeconds,
                  whitelistEnabled,
                }),
              })
            }
          >
            {pending === "rules" ? "Отправляем транзакцию…" : "Сохранить правила"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold">Whitelist получателей</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="0x… адрес"
            className="font-mono text-sm"
            aria-label="Адрес получателя"
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={pending !== null || !target}
              onClick={() =>
                save("whitelist", {
                  method: "POST",
                  body: JSON.stringify({target, allowed: true}),
                })
              }
            >
              Разрешить
            </Button>
            <Button
              variant="outline"
              disabled={pending !== null || !target}
              onClick={() =>
                save("whitelist", {
                  method: "POST",
                  body: JSON.stringify({target, allowed: false}),
                })
              }
            >
              Запретить
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Список хранится в контракте кошелька; изменение — отдельная транзакция.
          </p>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}
      {saved && !error && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckIcon className="size-4" />
          Изменения записаны в контракт.
        </p>
      )}
    </div>
  );
}
