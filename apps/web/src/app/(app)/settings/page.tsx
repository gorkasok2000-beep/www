import {redirect} from "next/navigation";
import {formatEther} from "viem";

import {RulesForm} from "@/components/app/rules-form";
import {Card, CardContent} from "@/components/ui/card";
import {agentState} from "@/lib/agents";
import {currentAgent} from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const agent = await currentAgent();
  if (!agent) {
    redirect("/register");
  }

  const state = await agentState(agent);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Правила</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ограничения исполняет контракт кошелька, а не приложение: обойти их через API
          невозможно.
        </p>
      </div>

      {agent.mode === "AUTONOMOUS_ENTITY" ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm font-medium">Это автономный агент</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              У кошелька нет кастодиана, поэтому правил не существует — не только в
              интерфейсе, но и в самом контракте. Такой агент распоряжается средствами
              полностью самостоятельно.
            </p>
          </CardContent>
        </Card>
      ) : (
        <RulesForm
          initialLimitEth={formatEther(state.rules.limitWei)}
          initialPeriodSeconds={Number(state.rules.periodSeconds)}
          initialWhitelistEnabled={state.rules.whitelistEnabled}
        />
      )}
    </div>
  );
}
