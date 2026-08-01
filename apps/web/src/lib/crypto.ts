import {createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual} from "node:crypto";

import {serverEnv} from "./env";

/**
 * Шифрование приватных ключей агентов и работа с API-ключами.
 *
 * ВНИМАНИЕ ДЛЯ АУДИТА: в прототипе сервер хранит приватные ключи агентов у себя,
 * зашифрованными симметричным ключом из окружения. Это осознанное упрощение, чтобы
 * агент мог платить одним HTTP-запросом, не поднимая собственную подпись. В проде
 * ключи должны жить в KMS/HSM (или у самого агента), а сервер — только собирать
 * UserOperation и отдавать его на подпись.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function key(): Buffer {
  const raw = serverEnv.encryptionKey().replace(/^0x/, "");
  const buffer = Buffer.from(raw, "hex");
  if (buffer.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY должен быть 32 байтами в hex (openssl rand -hex 32).");
  }
  return buffer;
}

/** Возвращает строку вида `iv.authTag.ciphertext` в base64. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, ciphertext].map((part) => part.toString("base64")).join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Повреждённые зашифрованные данные.");
  }

  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** API-ключ агента. Показывается один раз при регистрации, в базе лежит только хеш. */
export function generateApiKey(): string {
  return `sk_agent_${randomBytes(24).toString("hex")}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Отпечаток тела запроса для идемпотентности.
 *
 * Сравнивается не сам текст запроса, а нормализованные значения: регистр адреса и
 * порядок полей не должны превращать честный повтор в конфликт, а изменение суммы —
 * обязано.
 */
export function hashRequest(parts: Record<string, string>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key].toLowerCase()}`)
    .join("&");

  return createHash("sha256").update(canonical).digest("hex");
}

/** Сравнение хешей за постоянное время — чтобы не подсказывать ключ по таймингу. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
