/**
 * Структурные логи.
 *
 * До сих пор в коде было два `console.warn` без единого идентификатора: по такому логу
 * нельзя ни связать запрос агента с операцией в сети, ни разобрать инцидент постфактум.
 * Здесь одна функция и фиксированный набор ключей — именно тот, по которому приходится
 * искать при разборе: запрос, агент, платёж, операция, транзакция.
 *
 * Формат — одна JSON-строка на событие: её одинаково читают и человек, и сборщик логов.
 */

export type LogFields = {
  requestId?: string;
  agentId?: string;
  paymentId?: string;
  invoiceId?: string;
  userOpHash?: string;
  txHash?: string;
  status?: number | string;
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
};

export type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, event: string, fields: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    // undefined из JSON.stringify выпадают сами — пустых ключей в строке не будет.
    ...fields,
  });

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (event: string, fields: LogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => write("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => write("error", event, fields),
};

/** Короткое описание ошибки для лога: без стека, но с сутью. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
