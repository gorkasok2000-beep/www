import {ArrowUpRightIcon} from "lucide-react";

import {Badge} from "@/components/ui/badge";
import {formatEth, MODE_LABEL, timeAgo} from "@/lib/format";

export type FeedItem = {
  handle: string;
  mode: string;
  to: string;
  valueWei: string;
  txHash: string;
  timestamp: string;
};

/**
 * Живая лента трат. Показывает действие и не показывает личность: публичное имя
 * агента, усечённый адрес получателя, сумма и время — больше в ленте ничего нет.
 */
export function TransactionFeed({items}: {items: FeedItem[]}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="text-sm text-muted-foreground">
          Пока ни один агент не совершил трату. Лента заполнится сама.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y rounded-xl border">
      {items.map((item) => (
        <div
          key={`${item.txHash}-${item.timestamp}-${item.handle}`}
          className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ArrowUpRightIcon className="size-4 text-muted-foreground" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{item.handle}</span>
              <Badge variant="secondary" className="hidden text-xs font-normal sm:inline-flex">
                {MODE_LABEL[item.mode] ?? item.mode}
              </Badge>
            </div>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">→ {item.to}</p>
          </div>

          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold tabular-nums">{formatEth(item.valueWei)} ETH</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{timeAgo(item.timestamp)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
