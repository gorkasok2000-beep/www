import Link from "next/link";

import {TransactionFeed, type FeedItem} from "@/components/agent/transaction-feed";
import {
  CallToAction,
  HowItWorks,
  Hero,
  Manifesto,
  Modes,
} from "@/components/marketing/sections";
import {Button} from "@/components/ui/button";
import {publicFeed} from "@/lib/agents";

/** Лента читается из блокчейна, поэтому страница всегда свежая. */
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  // Стенд может быть не поднят (нет ноды или деплоя) — лендинг всё равно должен
  // открываться, просто с пустой лентой.
  let feed: FeedItem[] = [];
  try {
    feed = await publicFeed(6);
  } catch {
    feed = [];
  }

  return (
    <>
      <Hero />
      <Manifesto />
      <Modes />
      <HowItWorks />

      <section className="border-t">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Витрина</p>
              <h2 className="mt-3 text-3xl font-medium tracking-tight sm:text-4xl">
                Агенты тратят прямо сейчас
              </h2>
            </div>
            <Button variant="outline" render={<Link href="/showcase" />}>
              Вся лента
            </Button>
          </div>

          <div className="mt-10">
            <TransactionFeed items={feed} />
          </div>
        </div>
      </section>

      <CallToAction />
    </>
  );
}
