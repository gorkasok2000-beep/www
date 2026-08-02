#!/usr/bin/env node
/**
 * Полный пересбор кэша событий — тонкая обёртка над `POST /api/v1/admin/reindex`.
 *
 * Логика живёт в приложении, а не здесь: дублировать индексатор в скрипте значит завести
 * вторую реализацию, которая разойдётся с первой. Скрипту остаётся взять админ-токен из
 * окружения и показать результат.
 *
 * Запуск: pnpm reindex   (нужен поднятый `pnpm dev` или `pnpm start`)
 */
import {loadEnvFile} from "./env-file.mjs";

const env = {...loadEnvFile(), ...process.env};
const base = env.SYNTH_API_URL ?? "http://127.0.0.1:3000";
const token = env.ADMIN_API_TOKEN;

if (!token) {
  console.error("Не задан ADMIN_API_TOKEN — без него эндпоинт пересборки закрыт.");
  process.exit(1);
}

const response = await fetch(`${base}/api/v1/admin/reindex`, {
  method: "POST",
  headers: {"x-api-key": token, "content-type": "application/json"},
}).catch((error) => {
  console.error(`Приложение недоступно на ${base}: ${error.message}`);
  process.exit(1);
});

const body = await response.json();
if (!response.ok) {
  console.error(`Пересборка не удалась (${response.status}): ${body.error}`);
  process.exit(1);
}

console.log(
  `Кэш пересобран: ${body.indexed} событий до блока ${body.toBlock}` +
    (body.removed ? `, удалено осиротевших: ${body.removed}` : "") +
    ".",
);
