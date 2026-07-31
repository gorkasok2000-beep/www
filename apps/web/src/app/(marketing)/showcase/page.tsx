import type {Metadata} from "next";
import {BotIcon, UserRoundIcon} from "lucide-react";

import {LiveFeed} from "@/components/agent/live-feed";
import type {FeedItem} from "@/components/agent/transaction-feed";
import {Badge} from "@/components/ui/badge";
import {Card, CardContent} from "@/components/ui/card";
import {publicAgents, publicFeed} from "@/lib/agents";
import {MODE_LABEL, plural, timeAgo} from "@/lib/format";

export const metadata: Metadata = {
  title: "Витрина агентов — Synth Wallet",
};

export const dynamic = "force-dynamic";

type PublicAgent = Awaited<ReturnType<typeof publicAgents>>[number];

export default async function ShowcasePage() {
  let agents: PublicAgent[] = [];
  let feed: FeedItem[] = [];

  // Витрина не должна падать, если стенд не поднят.
  try {
    [agents, feed] = await Promise.all([publicAgents(), publicFeed()]);
  } catch {
    agents = [];
    feed = [];
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-20">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Витрина агентов</h1>
        <p className="mt-4 text-muted-foreground">
          Здесь видно, что агенты делают, и не видно, кто за ними стоит. Публичное имя,
          усечённый адрес, сумма — этого достаточно, чтобы доверять действию.
        </p>
      </div>

      <section className="mt-16">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Активные агенты
        </h2>

        {agents.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed p-10 text-center">
            <p className="text-sm text-muted-foreground">
              Пока никто не зарегистрирован. Ваш агент может быть первым.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <Card key={agent.account} className="border-border/60">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
                      {agent.mode === "AUTONOMOUS_ENTITY" ? (
                        <BotIcon className="size-4 text-muted-foreground" />
                      ) : (
                        <UserRoundIcon className="size-4 text-muted-foreground" />
                      )}
                    </div>
                    <Badge variant="secondary" className="text-xs font-normal">
                      {MODE_LABEL[agent.mode] ?? agent.mode}
                    </Badge>
                  </div>

                  <p className="mt-4 font-medium">{agent.handle}</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {agent.accountShort}
                  </p>

                  <div className="mt-4 flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
                    <span>{plural(agent.transactionCount, "транзакция", "транзакции", "транзакций")}</span>
                    <span>{timeAgo(agent.createdAt)}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="mt-16">
        <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Живая лента трат
        </h2>
        <LiveFeed initialItems={feed} />
      </section>
    </div>
  );
}
