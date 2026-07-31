/** Форматирование для интерфейса. Безопасно для клиента: без обращений к ноде и БД. */

export function formatEth(wei: bigint | string, digits = 4): string {
  const value = typeof wei === "string" ? BigInt(wei) : wei;
  const eth = Number(value) / 1e18;

  if (eth === 0) return "0";
  if (eth < 0.0001) return "<0.0001";
  return eth.toFixed(digits).replace(/\.?0+$/, "");
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export const MODE_LABEL: Record<string, string> = {
  HUMAN_CUSTODIAN: "Human Custodian",
  AUTONOMOUS_ENTITY: "Autonomous Entity",
};

export function formatPeriod(seconds: number): string {
  if (seconds === 0) return "за транзакцию";
  if (seconds % 86400 === 0) return `за ${seconds / 86400} сут.`;
  if (seconds % 3600 === 0) return `за ${seconds / 3600} ч`;
  if (seconds % 60 === 0) return `за ${seconds / 60} мин`;
  return `за ${seconds} с`;
}

/** Русские склонения: «1 транзакция», «2 транзакции», «5 транзакций». */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;

  if (mod100 >= 11 && mod100 <= 14) return `${count} ${many}`;
  if (mod10 === 1) return `${count} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

/** «3 мин назад» — лента должна читаться как живая. */
export function timeAgo(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));

  if (seconds < 60) return "только что";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
  return `${Math.floor(seconds / 86400)} сут. назад`;
}
