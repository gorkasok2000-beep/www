import {
  ArrowLeftRightIcon,
  ShieldCheckIcon,
  SnowflakeIcon,
  TriangleAlertIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";
import {redirect} from "next/navigation";

import {SignerCard} from "@/components/app/signer-card";
import {WalletActions} from "@/components/app/wallet-actions";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Progress} from "@/components/ui/progress";
import {agentState, agentTransactions} from "@/lib/agents";
import {currentAgent} from "@/lib/auth";
import {gasOutlook, signingOverview} from "@/lib/cabinet";
import {formatEth, formatPeriod, MODE_LABEL, plural, shortAddress, timeAgo} from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const agent = await currentAgent();
  if (!agent) {
    redirect("/register");
  }

  const [state, transactions, signing] = await Promise.all([
    agentState(agent),
    agentTransactions(agent, 8),
    signingOverview(agent),
  ]);

  const gas = await gasOutlook(state);

  const hasLimit = state.rules.limitWei > 0n;
  const spentInWindow = hasLimit ? state.rules.limitWei - state.spendingRemainingWei : 0n;
  const usedPercent = hasLimit
    ? Number((spentInWindow * 100n) / state.rules.limitWei)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-medium tracking-tight">{agent.handle}</h1>
        <Badge variant="secondary">{MODE_LABEL[agent.mode] ?? agent.mode}</Badge>
        {state.frozen && (
          <Badge variant="destructive" className="gap-1">
            <SnowflakeIcon className="size-3" />
            Заморожен
          </Badge>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon={<WalletIcon className="size-4 text-muted-foreground" />}
          label="Баланс кошелька"
          value={`${formatEth(state.balanceWei)} ETH`}
          hint="Доступно агенту для трат"
        />
        <StatCard
          icon={<ShieldCheckIcon className="size-4 text-muted-foreground" />}
          label="Хватит на газ"
          value={gas.enough ? `≈ ${gas.operationsLeft} опер.` : "нет"}
          hint={`Одна операция ≈ ${formatEth(gas.operationCostWei)} ETH; депозит ${formatEth(state.gasDepositWei)} ETH`}
        />
        <StatCard
          icon={<ArrowLeftRightIcon className="size-4 text-muted-foreground" />}
          label="Транзакций"
          value={String(transactions.length)}
          hint={`${plural(transactions.length, "запись", "записи", "записей")} в публичном логе`}
        />
      </div>

      {!gas.enough && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex gap-3 pt-6">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div className="text-sm">
              <p className="font-medium">Средств не хватит даже на одну операцию.</p>
              <p className="mt-1 text-muted-foreground">
                Кошелёк платит за газ сам, поэтому непустой баланс ещё не значит, что
                платёж пройдёт. Пополните кошелёк минимум на{" "}
                {formatEth(gas.operationCostWei)} ETH сверх суммы платежа.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {!signing.canPay && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex gap-3 pt-6">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div className="text-sm">
              <p className="font-medium">Платформе нечем подписывать операции.</p>
              <p className="mt-1 text-muted-foreground">
                Главный ключ у агента, а действующего ключа с бюджетом платформе не выдано.
                Выпустите его в карточке «Подпись операций» — до этого платежи будут
                отклоняться.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {agent.mode === "HUMAN_CUSTODIAN" && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                <CardTitle className="text-base font-semibold">Лимит трат</CardTitle>
                <Button variant="outline" size="sm" render={<Link href="/settings" />}>
                  Настроить
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                {hasLimit ? (
                  <>
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Лимит {formatPeriod(Number(state.rules.periodSeconds))}
                      </p>
                      <p className="text-2xl font-bold tabular-nums tracking-tight">
                        {formatEth(state.rules.limitWei)}{" "}
                        <span className="text-sm font-normal text-muted-foreground">ETH</span>
                      </p>
                    </div>

                    <Progress value={usedPercent} className="h-2" />

                    <div className="flex items-center justify-between text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Потрачено в окне</p>
                        <p className="font-semibold tabular-nums">
                          {formatEth(spentInWindow)} ETH
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Осталось</p>
                        <p className="font-semibold tabular-nums">
                          {formatEth(state.spendingRemainingWei)} ETH
                        </p>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Лимит не задан — агент тратит в пределах баланса.
                    {state.rules.whitelistEnabled && " Действует whitelist получателей."}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
              <CardTitle className="text-base font-semibold">Последние транзакции</CardTitle>
              <Button variant="outline" size="sm" render={<Link href="/transactions" />}>
                Вся история
              </Button>
            </CardHeader>
            <CardContent>
              {transactions.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Агент ещё ничего не потратил.
                </p>
              ) : (
                <div className="divide-y">
                  {transactions.map((tx) => (
                    <div key={`${tx.txHash}-${tx.logIndex}`} className="flex items-center gap-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-sm">{shortAddress(tx.to)}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {timeAgo(tx.timestamp)}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-semibold tabular-nums">
                        −{formatEth(tx.valueWei)} ETH
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <WalletActions frozen={state.frozen} />
          <SignerCard
            mode={signing.mode}
            signerUrl={signing.signerUrl}
            sessionKey={
              signing.sessionKey && {
                address: signing.sessionKey.address,
                budgetWei: signing.sessionKey.budgetWei.toString(),
                spentWei: signing.sessionKey.spentWei.toString(),
                remainingWei: signing.sessionKey.remainingWei.toString(),
                validUntil: signing.sessionKey.validUntil.toISOString(),
                targetsRestricted: signing.sessionKey.targetsRestricted,
                registered: signing.sessionKey.registered,
              }
            }
          />
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <div className="flex size-8 items-center justify-center rounded-lg bg-muted">{icon}</div>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold tabular-nums tracking-tight">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
