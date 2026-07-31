#!/usr/bin/env node
/**
 * Сборка демо-страницы в один самодостаточный HTML-файл.
 *
 * Собирается из четырёх частей:
 *   1. скомпилированный бандл Tailwind из продакшн-сборки приложения — благодаря
 *      этому демо выглядит ровно так же, как настоящий апп, а не «похоже»;
 *   2. demo/extra.css — правки, специфичные для одностраничного демо;
 *   3. demo/design-tokens.json — классы shadcn-примитивов и SVG иконок, снятые
 *      с работающего приложения (см. README, раздел про демо);
 *   4. demo/app.js — мок-стейт и рендер экранов.
 *
 * Запуск:
 *   pnpm --filter web build     # сначала нужен .next с бандлом стилей
 *   node demo/build.mjs
 */
import {readFileSync, writeFileSync, readdirSync, mkdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const chunks = join(root, "apps", "web", ".next", "static", "chunks");

function tailwindCss() {
  let files;
  try {
    files = readdirSync(chunks).filter((name) => name.endsWith(".css"));
  } catch {
    files = [];
  }

  if (files.length === 0) {
    console.error(
      "Не найден скомпилированный CSS в apps/web/.next/static/chunks.\n" +
        "Сначала соберите приложение: pnpm --filter web build",
    );
    process.exit(1);
  }

  // Бандл стилей у Next один; если их несколько, берём самый крупный.
  const biggest = files
    .map((name) => join(chunks, name))
    .sort((a, b) => readFileSync(b).length - readFileSync(a).length)[0];

  return readFileSync(biggest, "utf8");
}

const tokens = readFileSync(join(here, "design-tokens.json"), "utf8");
const app = readFileSync(join(here, "app.js"), "utf8");
const extra = readFileSync(join(here, "extra.css"), "utf8");

// Обёртка артефакта подставляет свой <head>, но эти два мета-тега объявляем сами:
// без charset кириллица превращается в мусор там, где Content-Type её не несёт,
// а без viewport мобильный браузер верстает страницу на 980px и показывает
// уменьшенный десктоп вместо мобильного макета.
const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synth Wallet — демо прототипа</title>
<style>
${tailwindCss()}
${extra}
</style>

<!--
  Демонстрационная сборка прототипа Synth Wallet.
  Сгенерировано demo/build.mjs — редактировать надо demo/app.js, а не этот файл.
-->
<div id="app" class="dark"></div>

<script>window.__SYNTH_TOKENS__ = ${tokens};</script>
<script>
${app}
</script>
`;

const target = join(here, "synth-wallet-demo.html");
writeFileSync(target, html);
console.log(`${target} — ${(html.length / 1024).toFixed(0)} КБ`);

// Вторая копия — точка входа для GitHub Pages: в настройках репозитория Pages умеют
// раздавать папку /docs текущей ветки, поэтому отдельная ветка не нужна.
// Пишем из того же исходника, чтобы копии не разъезжались.
mkdirSync(join(root, "docs"), {recursive: true});
const pagesTarget = join(root, "docs", "index.html");
writeFileSync(pagesTarget, html);
console.log(`${pagesTarget} — та же сборка для GitHub Pages`);
