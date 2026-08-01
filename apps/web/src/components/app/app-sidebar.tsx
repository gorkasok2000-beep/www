"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {
  ArrowLeftRightIcon,
  BotIcon,
  LayoutDashboardIcon,
  RadioIcon,
  ReceiptIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {MODE_LABEL} from "@/lib/format";

/** Навигация дашборда. Структура и компоненты — из shadcn-fintech, пункты наши. */
const NAV = [
  {
    label: "Кошелёк",
    items: [
      {title: "Обзор", url: "/dashboard", icon: LayoutDashboardIcon},
      {title: "Платежи", url: "/payments", icon: ReceiptIcon},
      {title: "Транзакции", url: "/transactions", icon: ArrowLeftRightIcon},
      {title: "Правила", url: "/settings", icon: SlidersHorizontalIcon},
    ],
  },
  {
    label: "Публично",
    items: [{title: "Витрина агентов", url: "/showcase", icon: RadioIcon}],
  },
];

export function AppSidebar({agent}: {agent: {handle: string; mode: string; accountShort: string}}) {
  const pathname = usePathname();

  return (
    <Sidebar variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <span className="text-sm font-semibold">S</span>
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Synth Wallet</span>
                <span className="truncate text-xs text-muted-foreground">
                  Кошелёк ИИ-агента
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    isActive={pathname === item.url}
                    tooltip={item.title}
                    render={<Link href={item.url} />}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted">
                <BotIcon className="size-4 text-muted-foreground" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{agent.handle}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {MODE_LABEL[agent.mode] ?? agent.mode}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
