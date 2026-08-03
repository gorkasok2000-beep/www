#!/usr/bin/env node
/**
 * Проверка окружения перед запуском.
 *
 * Обязательные переменные читаются в `apps/web/src/lib/env.ts` лениво, поэтому их
 * отсутствие всплывает не при старте, а где-нибудь в середине запроса — уже как 500.
 * Этот скрипт переносит проверку в начало: до `pnpm dev`, до `pnpm e2e` и в CI.
 *
 * Запуск: pnpm check-env
 */
import {existsSync} from "node:fs";

import {envFilePath, loadEnvFile} from "./env-file.mjs";

/** @type {{name: string, why: string, check?: (value: string) => string | null}[]} */
const REQUIRED = [
  {
    name: "APP_ENCRYPTION_KEY",
    why: "им шифруются ключи агентов и session keys",
    check: (value) =>
      /^(0x)?[0-9a-fA-F]{64}$/.test(value)
        ? null
        : "нужно 32 байта в hex: openssl rand -hex 32",
  },
  {
    name: "RELAYER_PRIVATE_KEY",
    why: "этим ключом оператор регистрирует агентов и отправляет handleOps локально",
    check: (value) => (/^0x[0-9a-fA-F]{64}$/.test(value) ? null : "нужен приватный ключ 0x…"),
  },
  {name: "ADMIN_API_TOKEN", why: "им защищён эндпоинт заморозки"},
  {name: "DATABASE_URL", why: "без него Prisma не поднимется"},
];

const OPTIONAL = [
  ["NEXT_PUBLIC_CHAIN_ID", "31337", "сеть приложения"],
  ["RPC_URL", "http://127.0.0.1:8545", "нода"],
  ["BUNDLER_URL", "(нет — операции идут прямо в EntryPoint)", "бандлеры через запятую"],
  ["FAUCET_ENABLED", "true", "тестовый кран и выдача газа"],
  ["CONFIRMATION_BLOCKS", "(0 локально, 2 в остальных сетях)", "глубина подтверждения платежа"],
  ["RATE_LIMIT_ENABLED", "true", "лимиты запросов и блокировка за перебор ключей"],
  ["RATE_LIMIT_API_PER_MIN", "300", "общий лимит запросов в минуту на идентичность"],
  ["RATE_LIMIT_REGISTER_PER_HOUR", "10", "лимит регистраций в час с одного IP"],
  ["RATE_LIMIT_ADMIN_PER_MIN", "30", "лимит запросов к admin-эндпоинтам в минуту"],
  ["AUTH_LOCKOUT_THRESHOLD", "10", "неудач аутентификации до блокировки IP"],
  ["AUTH_LOCKOUT_WINDOW_MIN", "10", "окно подсчёта неудач, минут"],
  ["AUTH_LOCKOUT_DURATION_MIN", "15", "длительность блокировки, минут"],
];

const fromFile = loadEnvFile();
const read = (name) => process.env[name] ?? fromFile[name];

const problems = [];
for (const {name, why, check} of REQUIRED) {
  const value = read(name);
  if (!value) {
    problems.push(`${name} — не задана (${why})`);
    continue;
  }
  const invalid = check?.(value);
  if (invalid) {
    problems.push(`${name} — ${invalid}`);
  }
}

if (!existsSync(envFilePath)) {
  problems.push(`нет apps/web/.env.local — скопируйте .env.example`);
}

if (problems.length > 0) {
  console.error("Окружение не готово:\n");
  for (const problem of problems) {
    console.error(`  • ${problem}`);
  }
  console.error("\nПодробности — в .env.example и README.");
  process.exit(1);
}

console.log("Окружение в порядке.");
for (const [name, fallback, what] of OPTIONAL) {
  console.log(`  ${name.padEnd(30)} ${read(name) ?? fallback}   — ${what}`);
}
