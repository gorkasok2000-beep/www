#!/usr/bin/env node
/**
 * Подготовка репозитория к запуску одной командой.
 *
 * Раньше последовательность была расписана в README прозой, и пропустить шаг было
 * легко — особенно `git submodule update`, без которого контракты просто не собираются,
 * и `export-abi`, без которого приложение работает со старым ABI и не может расшифровать
 * новые ошибки контракта.
 *
 * Что делает: сабмодули → сборка контрактов → перенос ABI → схема БД → проверка
 * окружения. Сеть и деплой не трогает: `anvil` и `pnpm deploy:local` остаются за вами,
 * потому что это долгоживущие процессы.
 *
 * Запуск: pnpm bootstrap
 */
import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";

import {envFilePath, repoRoot as root, withEnvFile} from "./env-file.mjs";

function step(title, command, args, options = {}) {
  process.stdout.write(`\n\x1b[1m▸ ${title}\x1b[0m\n`);
  try {
    execFileSync(command, args, {cwd: root, stdio: "inherit", env: withEnvFile(), ...options});
  } catch (error) {
    if (options.optional) {
      console.warn(`  пропущено: ${error.message.split("\n")[0]}`);
      return false;
    }
    console.error(`\n\x1b[31mШаг «${title}» не выполнен.\x1b[0m`);
    process.exit(1);
  }
  return true;
}

step("Сабмодули контрактов", "git", ["submodule", "update", "--init", "--recursive"]);

const hasForge = (() => {
  try {
    execFileSync("forge", ["--version"], {stdio: "ignore"});
    return true;
  } catch {
    return false;
  }
})();

if (hasForge) {
  step("Сборка контрактов", "forge", ["build", "--root", "contracts"]);
  step("Перенос ABI в приложение", "node", ["scripts/export-abi.mjs"]);
} else {
  console.warn(
    "\n\x1b[33mforge не найден — контракты не собраны, ABI не обновлён.\x1b[0m\n" +
      "Установите Foundry: https://getfoundry.sh",
  );
}

if (!existsSync(envFilePath)) {
  console.warn(
    "\n\x1b[33mНет apps/web/.env.local — скопируйте .env.example и заполните.\x1b[0m",
  );
} else {
  step("Схема базы данных", "pnpm", ["--filter", "web", "exec", "prisma", "migrate", "deploy"]);
  step("Клиент Prisma", "pnpm", ["--filter", "web", "exec", "prisma", "generate"]);
  step("Проверка окружения", "node", ["scripts/check-env.mjs"]);
}

console.log(`
\x1b[32mГотово.\x1b[0m Дальше — три терминала:

  1. anvil
  2. PRIVATE_KEY=0xac09…ff80 pnpm deploy:local
  3. pnpm dev

Сквозная проверка по живому стенду: pnpm e2e
`);
