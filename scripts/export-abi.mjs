#!/usr/bin/env node
/**
 * Переносит ABI скомпилированных контрактов из `contracts/out` в веб-приложение.
 *
 * Запускается после `forge build`. Держать копию ABI в репозитории удобнее, чем читать
 * артефакты Foundry из Next.js: сборка фронтенда не зависит от установленного Foundry,
 * а viem получает литеральные типы благодаря `as const`.
 *
 *   node scripts/export-abi.mjs
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "contracts", "out");
const target = join(root, "apps", "web", "src", "lib", "chain", "abis.ts");

/** Контракты, чьи ABI нужны фронтенду и API. */
const CONTRACTS = [
  ["agentAccountAbi", "AgentAccount.sol", "AgentAccount"],
  ["agentAccountFactoryAbi", "AgentAccountFactory.sol", "AgentAccountFactory"],
  ["agentRegistryAbi", "AgentRegistry.sol", "AgentRegistry"],
  ["entryPointAbi", "EntryPoint.sol", "EntryPoint"],
];

if (!existsSync(outDir)) {
  console.error("contracts/out не найден — сначала выполните `forge build --root contracts`.");
  process.exit(1);
}

const chunks = [
  "// СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактировать руками.",
  "// Источник: contracts/out (forge build). Обновить: node scripts/export-abi.mjs",
  "",
];

for (const [exportName, file, contract] of CONTRACTS) {
  const artifactPath = join(outDir, file, `${contract}.json`);
  if (!existsSync(artifactPath)) {
    console.error(`Артефакт не найден: ${artifactPath}`);
    process.exit(1);
  }

  const {abi} = JSON.parse(readFileSync(artifactPath, "utf8"));
  chunks.push(`export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;`, "");
}

mkdirSync(dirname(target), {recursive: true});
writeFileSync(target, chunks.join("\n"));

console.log(`ABI записаны в ${target}`);
