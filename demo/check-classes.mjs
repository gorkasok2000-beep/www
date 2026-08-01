#!/usr/bin/env node
/**
 * Ищет классы Tailwind, которых нет в бандле приложения.
 *
 * Бандл собран из того, что использовал `apps/web`, поэтому любая утилита,
 * придуманная только для демо (`animate-spin`, `scroll-mt-28`), молча не работает:
 * стиля для неё просто не существует. Проверка ловит это до того, как расхождение
 * увидит человек.
 *
 * Запуск: node demo/check-classes.mjs
 */
import {readFileSync, readdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * Бандл стилей ищем так же, как это делает `build.mjs`: имя файла содержит хеш и
 * меняется при каждой пересборке приложения, поэтому прописывать его нельзя.
 */
const chunks = join(root, "apps", "web", ".next", "static", "chunks");
const bundle = readdirSync(chunks)
  .filter((name) => name.endsWith(".css"))
  .map((name) => join(chunks, name))
  .sort((a, b) => readFileSync(b).length - readFileSync(a).length)[0];

if (!bundle) {
  console.error("Не найден скомпилированный CSS. Сначала: pnpm --filter web build");
  process.exit(1);
}

const css = readFileSync(bundle, "utf8") + readFileSync(join(here, "extra.css"), "utf8");

const sources = readdirSync(join(here, "src"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(join(here, "src", f), "utf8"))
  .join("\n");

/**
 * Разметка живёт и внутри `${…}`, поэтому вырезать интерполяции нельзя — вместе с
 * ними пропали бы настоящие классы. Вместо этого собираем всё и отсеиваем куски
 * выражений: обращения к свойствам, операторы и фрагменты с подстановкой.
 */
const OPERATOR = /^(===|!==|==|!=|\?|:|\|\||&&|\||\+|-)$/;
const PROPERTY_ACCESS = /^[A-Za-z_$][\w$]*\.[A-Za-z_$]/;
/** Классы-маркеры на SVG: стилей у них нет и не должно быть. */
const MARKERS = /^lucide(-|$)/;

const tokens = new Set();
for (const match of sources.matchAll(/class="([^"]*)"/g)) {
  for (const raw of match[1].split(/\s+/)) {
    if (!raw) continue;
    if (raw.includes("$") || raw.includes("{") || raw.includes("}") || raw.includes('"')) continue;
    if (OPERATOR.test(raw) || PROPERTY_ACCESS.test(raw) || MARKERS.test(raw)) continue;
    tokens.add(raw);
  }
}

/** Экранирование как в сгенерированном CSS: .text-\[10px\], .hover\:bg-muted\/20 */
const escapeClass = (name) => name.replace(/[.:/[\]()%!#,'"*+~<>=&?]/g, (c) => "\\" + c);

const missing = [...tokens]
  .filter((name) => !css.includes("." + escapeClass(name)))
  .sort();

if (missing.length === 0) {
  console.log("Все классы демо есть в стилях.");
  process.exit(0);
}

console.error(`Нет стилей для ${missing.length} классов:\n  ` + missing.join("\n  "));
process.exit(1);
