"use client";

import {useEffect, useState} from "react";

import {plural} from "@/lib/format";

import {TransactionFeed, type FeedItem} from "./transaction-feed";

/**
 * Лента с автообновлением. Опрос раз в 10 секунд — для витрины этого достаточно,
 * а нагрузку на ноду держит в разумных пределах.
 */
export function LiveFeed({initialItems}: {initialItems: FeedItem[]}) {
  const [items, setItems] = useState(initialItems);
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/v1/feed", {cache: "no-store"});
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as {transactions: FeedItem[]};
        setItems(body.transactions);
      } catch {
        // Нода недоступна — оставляем последнюю известную ленту.
      }
    }, 10_000);

    return () => clearInterval(timer);
  }, [live]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setLive((value) => !value)}
          className="flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span
            className={
              live
                ? "size-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/20"
                : "size-2 rounded-full bg-muted-foreground/50"
            }
          />
          {live ? "Обновляется в реальном времени" : "Обновление приостановлено"}
        </button>
        <span className="text-xs text-muted-foreground">
          {plural(items.length, "запись", "записи", "записей")}
        </span>
      </div>

      <TransactionFeed items={items} />
    </div>
  );
}
