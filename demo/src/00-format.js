// ---------------------------------------------------------------------
// Форматирование — перенос apps/web/src/lib/format.ts
// ---------------------------------------------------------------------

const T = window.__SYNTH_TOKENS__;

/** Ошибка, которую показываем пользователю как есть. */
class DemoError extends Error {}

const WEI = 1000000000000000000n;

function formatEth(wei, digits = 4) {
  const value = typeof wei === "bigint" ? wei : BigInt(wei);
  const eth = Number(value) / 1e18;
  if (eth === 0) return "0";
  if (eth < 0.0001) return "<0.0001";
  return eth.toFixed(digits).replace(/\.?0+$/, "");
}

/** Разбор строки «0.05» в wei без потери точности на дробной части. */
function parseEth(input) {
  const text = String(input).trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") {
    throw new DemoError("Введите сумму числом, например 0.05.");
  }
  const [whole, fraction = ""] = text.split(".");
  const padded = (fraction + "000000000000000000").slice(0, 18);
  return BigInt(whole || "0") * WEI + BigInt(padded || "0");
}

const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const MODE_LABEL = {
  HUMAN_CUSTODIAN: "Human Custodian",
  AUTONOMOUS_ENTITY: "Autonomous Entity",
};

function formatPeriod(seconds) {
  if (seconds === 0) return "за транзакцию";
  if (seconds % 86400 === 0) return `за ${seconds / 86400} сут.`;
  if (seconds % 3600 === 0) return `за ${seconds / 3600} ч`;
  if (seconds % 60 === 0) return `за ${seconds / 60} мин`;
  return `за ${seconds} с`;
}

function plural(count, one, few, many) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} ${many}`;
  if (mod10 === 1) return `${count} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

function timeAgo(value) {
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "только что";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
  return `${Math.floor(seconds / 86400)} сут. назад`;
}

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c],
  );

const randomHex = (bytes) => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const randomAddress = () => "0x" + randomHex(20);
const randomTxHash = () => "0x" + randomHex(32);
const minutesAgo = (m) => new Date(Date.now() - m * 60000);

const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value).trim());
