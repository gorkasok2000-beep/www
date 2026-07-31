import type {Metadata} from "next";
import {ThemeProvider} from "next-themes";

import {TooltipProvider} from "@/components/ui/tooltip";

import "./globals.css";

export const metadata: Metadata = {
  title: "Synth Wallet — кошелёк для ИИ-агентов",
  description:
    "ERC-4337 кошелёк, владельцем которого может быть ИИ-агент. Мы доверяем действию, а не документам.",
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return (
    <html lang="ru" className="h-full antialiased font-sans" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {/* Тёмная тема — основная и единственная: так требует стиль из ТЗ. */}
        <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark">
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
