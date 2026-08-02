#!/usr/bin/env node
/**
 * Разбор очереди повторной доставки вебхуков — обёртка над
 * `POST /api/v1/admin/webhooks/flush`.
 *
 * Отдельного воркера в прототипе нет: повторы подбираются попутно, при чтении платежей.
 * Этот скрипт заменяет планировщик — его можно позвать руками или из cron, пока очередь
 * не появилась по-настоящему.
 *
 * Запуск: pnpm webhooks:flush   (нужен поднятый `pnpm dev` или `pnpm start`)
 */
import {loadEnvFile} from "./env-file.mjs";

const env = {...loadEnvFile(), ...process.env};
const base = env.SYNTH_API_URL ?? "http://127.0.0.1:3000";
const token = env.ADMIN_API_TOKEN;

if (!token) {
  console.error("Не задан ADMIN_API_TOKEN — без него эндпоинт разбора очереди закрыт.");
  process.exit(1);
}

const response = await fetch(`${base}/api/v1/admin/webhooks/flush`, {
  method: "POST",
  headers: {"x-api-key": token, "content-type": "application/json"},
}).catch((error) => {
  console.error(`Приложение недоступно на ${base}: ${error.message}`);
  process.exit(1);
});

const body = await response.json();
if (!response.ok) {
  console.error(`Разбор очереди не удался (${response.status}): ${body.error}`);
  process.exit(1);
}

console.log(`Доставлено: ${body.delivered}, не удалось: ${body.failed}.`);
