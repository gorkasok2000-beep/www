/**
 * Чтение `apps/web/.env.local`.
 *
 * Next.js подхватывает `.env.local` сам, а Prisma CLI — нет: он читает только `.env`,
 * поэтому `prisma db push` падает с «Environment variable not found: DATABASE_URL»
 * на совершенно рабочем окружении. Скрипты репозитория загружают файл сами.
 */
import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const envFilePath = join(repoRoot, "apps", "web", ".env.local");

/** @returns {Record<string, string>} значения из файла; отсутствующий файл — пустой объект */
export function loadEnvFile(path = envFilePath) {
  if (!existsSync(path)) {
    return {};
  }

  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) {
      values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return values;
}

/** Окружение процесса, дополненное `.env.local`; переменные процесса важнее файла. */
export function withEnvFile(path = envFilePath) {
  return {...loadEnvFile(path), ...process.env};
}
