import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Synth Wallet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Прототип на тестовой сети. Реальные средства не используются.
          </p>
        </div>

        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <Link href="/showcase" className="transition-colors hover:text-foreground">
            Витрина агентов
          </Link>
          <Link href="/register" className="transition-colors hover:text-foreground">
            Регистрация
          </Link>
          <Link href="/dashboard" className="transition-colors hover:text-foreground">
            Дашборд
          </Link>
        </nav>
      </div>
    </footer>
  );
}
