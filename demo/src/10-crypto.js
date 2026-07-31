// ---------------------------------------------------------------------
// Ключи доступа: keystore вместо логина и пароля
// ---------------------------------------------------------------------

/**
 * Вход в кабинет устроен как в кошельках Ethereum, а не как в обычных сервисах:
 * аккаунта на сервере нет, есть приватный ключ агента. Ключ шифруется парольной
 * фразой и лежит у владельца — в браузере и в скачанном файле keystore.
 *
 * Шифрование настоящее: PBKDF2-SHA256 + AES-256-GCM через WebCrypto. Неверная
 * парольная фраза заваливает проверку тега аутентификации, поэтому «подобрать»
 * ответ невозможно даже имея файл. Парольная фраза никуда не сохраняется.
 */

const KDF_ITERATIONS = 210000;

/** WebCrypto доступен только в защищённом контексте — молча притворяться нельзя. */
function requireSubtle() {
  if (!globalThis.crypto?.subtle) {
    throw new DemoError(
      "Браузер не даёт доступ к WebCrypto в этом окружении, зашифровать ключ невозможно. " +
        "Откройте страницу по https.",
    );
  }
  return crypto.subtle;
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt) {
  const subtle = requireSubtle();
  const material = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return subtle.deriveKey(
    {name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: "SHA-256"},
    material,
    {name: "AES-GCM", length: 256},
    false,
    ["encrypt", "decrypt"],
  );
}

/** Шифрует секрет агента парольной фразой и возвращает keystore-объект. */
async function createKeystore(secret, passphrase, meta) {
  const subtle = requireSubtle();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await subtle.encrypt({name: "AES-GCM", iv}, key, secret);

  return {
    version: 1,
    kdf: `pbkdf2-sha256:${KDF_ITERATIONS}`,
    cipher: "aes-256-gcm",
    handle: meta.handle,
    mode: meta.mode,
    address: meta.address,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    createdAt: new Date().toISOString(),
  };
}

/** Расшифровывает keystore. Неверная фраза — исключение, а не пустой результат. */
async function openKeystore(keystore, passphrase) {
  const subtle = requireSubtle();
  const key = await deriveKey(passphrase, fromBase64(keystore.salt));

  try {
    const plain = await subtle.decrypt(
      {name: "AES-GCM", iv: fromBase64(keystore.iv)},
      key,
      fromBase64(keystore.ciphertext),
    );
    return new Uint8Array(plain);
  } catch {
    throw new DemoError("Не удалось расшифровать ключ: неверная парольная фраза.");
  }
}

// ---------------------------------------------------------------------
// Access Key — тот же секрет в виде, который можно записать на бумаге
// ---------------------------------------------------------------------

/** Алфавит Крокфорда: без I, L, O и U, чтобы не путать при переписывании. */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeAccessKey(secret) {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }

  return "SYNTH-" + (out.match(/.{1,5}/g) || []).join("-");
}

function decodeAccessKey(text) {
  const cleaned = String(text)
    .toUpperCase()
    .replace(/^SYNTH-/, "")
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[ILO]/g, (c) => ({I: "1", L: "1", O: "0"})[c]);

  let bits = 0;
  let value = 0;
  const out = [];

  for (const char of cleaned) {
    const index = BASE32.indexOf(char);
    if (index < 0) {
      throw new DemoError("В ключе доступа есть символы, которых в нём быть не может.");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  if (out.length !== 32) {
    throw new DemoError("Ключ доступа неполный: ожидается 52 символа после префикса SYNTH.");
  }
  return new Uint8Array(out);
}

/**
 * Адрес кошелька выводится из секрета детерминированно, поэтому один и тот же
 * ключ всегда открывает один и тот же кошелёк — как и в настоящем кошельке,
 * где адрес получается из приватного ключа.
 */
async function addressFromSecret(secret) {
  const digest = await requireSubtle().digest("SHA-256", secret);
  const bytes = new Uint8Array(digest).slice(0, 20);
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------
// API-ключи агента
// ---------------------------------------------------------------------

/**
 * Ключ показывается ровно один раз. Дальше в интерфейсе остаётся только
 * префикс — так же, как в настоящем API, где в базе лежит sha256-хеш
 * (apps/web/prisma/schema.prisma, поле apiKeyHash).
 */
function issueApiKey() {
  const secret = randomHex(24);
  const full = `sk_agent_${secret}`;
  return {
    id: randomHex(8),
    full,
    prefix: full.slice(0, 16),
    createdAt: new Date(),
    lastUsedAt: null,
    revoked: false,
  };
}
