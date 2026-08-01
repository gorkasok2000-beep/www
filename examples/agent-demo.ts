/**
 * Демонстрация из ТЗ: ИИ-агент как экономический субъект.
 *
 * Скрипт ходит только в публичный HTTP API — ровно так же, как это делал бы настоящий
 * агент из своего цикла принятия решений. Ни приватных ключей, ни знания о блокчейне
 * ему не требуется: есть API-ключ и решение потратить.
 *
 * Запуск (нужны поднятые anvil, задеплоенные контракты и `pnpm dev`):
 *   pnpm demo
 */

const API = process.env.SYNTH_API_URL ?? "http://127.0.0.1:3000/api/v1";

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: RequestInit & {apiKey?: string; idempotencyKey?: string} = {},
): Promise<Json> {
  const {apiKey, idempotencyKey, ...rest} = init;

  const response = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(apiKey ? {"x-api-key": apiKey} : {}),
      ...(idempotencyKey ? {"idempotency-key": idempotencyKey} : {}),
      ...rest.headers,
    },
  });

  const body = (await response.json()) as Json;
  if (!response.ok) {
    throw new Error(`${rest.method ?? "GET"} ${path} → ${response.status}: ${body.error}`);
  }
  return body;
}

function step(title: string) {
  console.log(`\n\x1b[1m▸ ${title}\x1b[0m`);
}

async function main() {
  const suffix = Math.random().toString(36).slice(2, 8);

  // ---------------------------------------------------------------------
  step("Autonomous Entity: агент регистрирует кошелёк сам, без кастодиана");
  // ---------------------------------------------------------------------
  const autonomous = await call("/agents", {
    method: "POST",
    body: JSON.stringify({handle: `orion-${suffix}`, mode: "AUTONOMOUS_ENTITY"}),
  });
  const autonomousKey = autonomous.apiKey as string;
  console.log("  кошелёк:", autonomous.account);
  console.log("  API-ключ:", `${autonomousKey.slice(0, 16)}…`);

  step("Пополнение кошелька из тестового крана");
  const deposit = await call("/agents/me/deposit", {
    method: "POST",
    apiKey: autonomousKey,
    body: JSON.stringify({valueEth: "2"}),
  });
  console.log("  баланс:", deposit.balanceEth, "ETH");

  step("Агент принимает решение и платит — один HTTP-запрос, без подтверждений");
  // Ключ идемпотентности обязателен: агент ретраит по своей логике, и без ключа
  // повторный запрос стал бы вторым платежом.
  const paymentKey = crypto.randomUUID();
  const payment = await call("/agents/me/transactions", {
    method: "POST",
    apiKey: autonomousKey,
    idempotencyKey: paymentKey,
    body: JSON.stringify({
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      valueEth: "0.25",
    }),
  });
  console.log("  платёж:", payment.id, "→", payment.status);
  console.log("  транзакция:", payment.txHash);

  const state = await call("/agents/me", {apiKey: autonomousKey});
  console.log("  баланс после оплаты:", state.balanceEth, "ETH");

  step("Сеть моргнула, агент повторил запрос тем же ключом — второй траты не будет");
  const retry = await call("/agents/me/transactions", {
    method: "POST",
    apiKey: autonomousKey,
    idempotencyKey: paymentKey,
    body: JSON.stringify({
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      valueEth: "0.25",
    }),
  });
  const afterRetry = await call("/agents/me", {apiKey: autonomousKey});
  console.log("  тот же платёж:", retry.id, retry.replayed ? "(повтор)" : "(НОВЫЙ — ошибка!)");
  console.log("  баланс не изменился:", afterRetry.balanceEth, "ETH");
  if (retry.id !== payment.id || afterRetry.balanceEth !== state.balanceEth) {
    console.log("  \x1b[31mОШИБКА: повтор создал второй платёж\x1b[0m");
    process.exitCode = 1;
  }

  // ---------------------------------------------------------------------
  step("Human Custodian: человек создаёт кошелёк агенту и ставит лимит 0.1 ETH в сутки");
  // ---------------------------------------------------------------------
  const custodial = await call("/agents", {
    method: "POST",
    body: JSON.stringify({
      handle: `atlas-${suffix}`,
      mode: "HUMAN_CUSTODIAN",
      rules: {limitEth: "0.1", periodSeconds: 86400, whitelistEnabled: false},
    }),
  });
  const custodialKey = custodial.apiKey as string;
  console.log("  кошелёк:", custodial.account);

  await call("/agents/me/deposit", {
    method: "POST",
    apiKey: custodialKey,
    body: JSON.stringify({valueEth: "2"}),
  });

  step("Трата в пределах лимита проходит");
  const allowed = await call("/agents/me/transactions", {
    method: "POST",
    apiKey: custodialKey,
    idempotencyKey: crypto.randomUUID(),
    body: JSON.stringify({to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", valueEth: "0.05"}),
  });
  console.log("  транзакция:", allowed.txHash);

  step("Трата сверх лимита отклоняется самим контрактом");
  try {
    await call("/agents/me/transactions", {
      method: "POST",
      apiKey: custodialKey,
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", valueEth: "1"}),
    });
    console.log("  \x1b[31mОШИБКА: лимит не сработал\x1b[0m");
    process.exitCode = 1;
  } catch (error) {
    console.log("  отклонено:", (error as Error).message.split("\n")[0]);
  }

  // ---------------------------------------------------------------------
  step("Счёт: получатель просит оплату, агент платит по идентификатору");
  // ---------------------------------------------------------------------
  const invoice = await call("/invoices", {
    method: "POST",
    apiKey: custodialKey,
    body: JSON.stringify({valueEth: "0.02", memo: "подписка на API"}),
  });
  console.log("  счёт:", invoice.id, "—", invoice.valueEth, "ETH,", invoice.memo);

  // Ключ идемпотентности не нужен: им служит сам счёт.
  const byInvoice = await call("/agents/me/transactions", {
    method: "POST",
    apiKey: autonomousKey,
    body: JSON.stringify({invoiceId: invoice.id}),
  });
  console.log("  оплачен:", byInvoice.status, byInvoice.txHash);

  step("Повторная оплата того же счёта не проходит");
  try {
    await call("/agents/me/transactions", {
      method: "POST",
      apiKey: autonomousKey,
      body: JSON.stringify({invoiceId: invoice.id}),
    });
    console.log("  \x1b[31mОШИБКА: счёт оплачен дважды\x1b[0m");
    process.exitCode = 1;
  } catch (error) {
    console.log("  отклонено:", (error as Error).message.split("\n")[0]);
  }

  // ---------------------------------------------------------------------
  step("Публичная лента: видно действие, а не личность");
  // ---------------------------------------------------------------------
  const feed = (await call("/feed")) as {transactions: Array<Record<string, string>>};
  for (const tx of feed.transactions.slice(0, 5)) {
    const eth = (Number(tx.valueWei) / 1e18).toFixed(4);
    console.log(`  ${tx.handle.padEnd(16)} → ${tx.to}  ${eth} ETH`);
  }

  console.log("\n\x1b[32mГотово.\x1b[0m Агент владеет кошельком, тратит сам, ограничения работают.\n");
}

main().catch((error) => {
  console.error("\n\x1b[31m" + (error as Error).message + "\x1b[0m\n");
  process.exit(1);
});
