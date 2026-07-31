import Link from "next/link";

import {Button} from "@/components/ui/button";

/** Шапка лендинга. Структура и посадка размеров взяты из crypgo-лендинга. */
export function SiteHeader() {
  const links = [
    {href: "/#manifest", label: "Манифест"},
    {href: "/#modes", label: "Сценарии"},
    {href: "/#how", label: "Как это работает"},
    {href: "/showcase", label: "Витрина"},
  ];

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <span className="text-sm font-semibold">S</span>
          </span>
          <span className="text-sm font-semibold tracking-tight">Synth Wallet</span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" render={<Link href="/dashboard" />}>
            Дашборд
          </Button>
          <Button size="sm" render={<Link href="/register" />}>
            Создать кошелёк
          </Button>
        </div>
      </div>
    </header>
  );
}
