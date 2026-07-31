import {redirect} from "next/navigation";

import {AppSidebar} from "@/components/app/app-sidebar";
import {SidebarInset, SidebarProvider, SidebarTrigger} from "@/components/ui/sidebar";
import {currentAgent} from "@/lib/auth";
import {shortAddress} from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AppLayout({children}: {children: React.ReactNode}) {
  // Сессия дашборда — тот же API-ключ, что получает агент. Нет ключа — нет кошелька.
  const agent = await currentAgent();
  if (!agent) {
    redirect("/register");
  }

  return (
    <SidebarProvider>
      <AppSidebar
        agent={{
          handle: agent.handle,
          mode: agent.mode,
          accountShort: shortAddress(agent.accountAddress),
        }}
      />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <span className="font-mono text-xs text-muted-foreground">
            {agent.accountAddress}
          </span>
        </header>
        <main className="flex flex-1 flex-col gap-6 p-4 pt-0 md:p-6 md:pt-0">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
