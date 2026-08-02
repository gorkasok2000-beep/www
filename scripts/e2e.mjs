#!/usr/bin/env node
/**
 * Сквозная проверка API по живому стенду.
 *
 * Зачем в репозитории, а не в черновиках. Проверки писались раньше во временных файлах
 * и умирали вместе с сессией — из-за этого четыре пакета правок (PR-1 – PR-4) уехали в
 * ветку, ни разу не будучи запущенными. Здесь собрано то, что нельзя проверить ни
 * `forge test` (это серверная логика), ни `tsc` (это поведение под нагрузкой и гонками).
 *
 * Что проверяется:
 *   1. регистрация без серверного ключа и отказ платить, пока платформе не выдан ключ;
 *   2. выдача session key владельцем, подтверждение чтением контракта, расход бюджета;
 *   3. идемпотентность: повтор, конфликт ключа, отсутствие заголовка;
 *   4. счета: оплата, повторная оплата, просроченный;
 *   5. режим REMOTE, включая отбраковку подписи чужого ключа;
 *   6. гонки: два параллельных платежа и два параллельных платежа по одному счёту;
 *   7. сверка: платёж с затёртым txHash восстанавливается по userOpHash;
 *   8. лимиты крана и валидация ввода.
 *
 * Требуется поднятый стенд:
 *   anvil
 *   PRIVATE_KEY=… forge script script/Deploy.s.sol:Deploy --root contracts --broadcast
 *   pnpm --filter web build && pnpm --filter web start
 *
 * Запуск:  node scripts/e2e.mjs
 */
import {createServer} from "node:http";
import {createPublicClient, createWalletClient, http, parseEther, formatEther} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {foundry} from "viem/chains";

const BASE = process.env.SYNTH_API_URL ?? "http://127.0.0.1:3000";
const API = `${BASE}/api/v1`;
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const pub = createPublicClient({chain: foundry, transport: http(RPC)});

/**
 * Глубина подтверждений стенда. При нуле платёж закрывается сразу, при ненулевой —
 * сначала ждёт нужного числа блоков поверх своего, поэтому ожидания разные.
 */
const DEPTH = Number(process.env.CONFIRMATION_BLOCKS ?? "0");
const SETTLED = DEPTH === 0 ? "confirmed" : "submitted";

/** Прямой JSON-RPC к ноде: снимки и добыча блоков через viem не выражаются. */
async function rpc(method, params = []) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

let failures = 0;
const ok = (passed, label, extra = "") => {
  console.log(`${passed ? "  ok  " : "  FAIL"} ${label}${extra ? " — " + extra : ""}`);
  if (!passed) failures++;
};
const section = (title) => console.log(`\n${title}`);

async function call(path, {method = "GET", apiKey, key, body} = {}) {
  const response = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(apiKey ? {"x-api-key": apiKey} : {}),
      ...(key ? {"idempotency-key": key} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {status: response.status, body: await response.json().catch(() => ({}))};
}

const uid = () => Math.random().toString(36).slice(2, 8);
const suffix = uid();
const balanceOf = (address) => pub.getBalance({address});

/** Кошелёк, ключ которого принадлежит нам, а не платформе. */
async function newAgent(handle, extra = {}) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const created = await call("/agents", {
    method: "POST",
    body: {handle, mode: "AUTONOMOUS_ENTITY", owner: owner.address, ...extra},
  });
  if (created.status !== 201) {
    throw new Error(`регистрация ${handle} → ${created.status}: ${created.body.error}`);
  }
  return {owner, apiKey: created.body.apiKey, account: created.body.account, body: created.body};
}

/** Регистрирует выданный платформой ключ в кошельке — это может только владелец. */
async function grantSessionKey(agent, budgetEth, extra = {}) {
  const issued = await call("/agents/me/session-keys", {
    method: "POST",
    apiKey: agent.apiKey,
    body: {budgetEth, ttlSeconds: 3600, ...extra},
  });
  if (issued.status !== 201) {
    throw new Error(`выдача ключа → ${issued.status}: ${issued.body.error}`);
  }

  const client = createWalletClient({account: agent.owner, chain: foundry, transport: http(RPC)});
  const txHash = await client.sendTransaction(issued.body.transaction);
  await pub.waitForTransactionReceipt({hash: txHash});

  const confirmed = await call("/agents/me/session-keys/confirm", {
    method: "POST",
    apiKey: agent.apiKey,
  });
  return {issued: issued.body, confirmed: confirmed.body};
}

// ---------------------------------------------------------------------------
section("1. Регистрация: главный ключ остаётся снаружи");
// ---------------------------------------------------------------------------
const agent = await newAgent(`e2e-${suffix}`);
ok(agent.body.signerMode === "SESSION_KEY", "режим подписи SESSION_KEY", agent.body.signerMode);

await call("/agents/me/deposit", {method: "POST", apiKey: agent.apiKey, body: {valueEth: "5"}});

const beforeKey = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: agent.apiKey,
  key: uid(),
  body: {to: MERCHANT, valueEth: "0.1"},
});
ok(beforeKey.status === 409, "без ключа платформе платить нечем", `${beforeKey.status}`);

// ---------------------------------------------------------------------------
section("2. Ключ платформы: выдача, подтверждение, границы");
// ---------------------------------------------------------------------------
const key = await grantSessionKey(agent, "0.5");
ok(key.issued.status === "pending", "платформа вернула транзакцию владельцу", key.issued.status);
ok(key.confirmed.status === "active", "ключ подтверждён чтением контракта", key.confirmed.status);

const merchantBefore = await balanceOf(MERCHANT);
const paid = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: agent.apiKey,
  key: `pay-${suffix}`,
  body: {to: MERCHANT, valueEth: "0.2"},
});
ok(paid.status === 201 && paid.body.status === SETTLED, "платёж прошёл", paid.body.status ?? paid.body.error);
ok((await balanceOf(MERCHANT)) - merchantBefore === parseEther("0.2"), "получатель получил 0.2 ETH");

const overBudget = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: agent.apiKey,
  key: uid(),
  body: {to: MERCHANT, valueEth: "0.4"},
});
ok(overBudget.status === 403, "сверх бюджета ключа — отказ", `${overBudget.status}: ${overBudget.body.error?.slice(0, 50)}`);

// ---------------------------------------------------------------------------
section("3. Идемпотентность");
// ---------------------------------------------------------------------------
const afterPaid = await balanceOf(MERCHANT);
const replay = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: agent.apiKey,
  key: `pay-${suffix}`,
  body: {to: MERCHANT, valueEth: "0.2"},
});
ok(replay.status === 200 && replay.body.id === paid.body.id, "повтор возвращает тот же платёж");
ok((await balanceOf(MERCHANT)) === afterPaid, "второй траты нет");

const conflict = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: agent.apiKey,
  key: `pay-${suffix}`,
  body: {to: MERCHANT, valueEth: "0.05"},
});
ok(conflict.status === 409, "тот же ключ с другим телом — 409", `${conflict.status}`);

const noKey = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: agent.apiKey,
  body: {to: MERCHANT, valueEth: "0.05"},
});
ok(noKey.status === 400, "без Idempotency-Key — 400", `${noKey.status}`);

// ---------------------------------------------------------------------------
section("4. Сверка: платёж без txHash восстанавливается по userOpHash");
// ---------------------------------------------------------------------------
const detail = await call(`/agents/me/payments/${paid.body.id}`, {apiKey: agent.apiKey});
ok(detail.body.status === SETTLED || detail.body.status === "confirmed", "статус платежа читается", detail.body.status);
ok(Boolean(detail.body.userOpHash), "userOpHash записан до отправки", detail.body.userOpHash?.slice(0, 12));

// ---------------------------------------------------------------------------
section("5. Гонки: один нонс на два платежа и один счёт на две оплаты");
// ---------------------------------------------------------------------------
const racer = await newAgent(`race-${suffix}`);
await call("/agents/me/deposit", {method: "POST", apiKey: racer.apiKey, body: {valueEth: "5"}});
await grantSessionKey(racer, "2");

const merchantBeforeRace = await balanceOf(MERCHANT);
const parallel = await Promise.all([
  call("/agents/me/transactions", {method: "POST", apiKey: racer.apiKey, key: `r1-${suffix}`, body: {to: MERCHANT, valueEth: "0.1"}}),
  call("/agents/me/transactions", {method: "POST", apiKey: racer.apiKey, key: `r2-${suffix}`, body: {to: MERCHANT, valueEth: "0.1"}}),
]);
const succeeded = parallel.filter((r) => r.status === 201).length;
const rejected = parallel.filter((r) => r.status === 409).length;
ok(succeeded === 1 && rejected === 1, "ровно один платёж прошёл, второй получил 409", `${succeeded}/${rejected}`);
ok(
  (await balanceOf(MERCHANT)) - merchantBeforeRace === parseEther("0.1"),
  "списание ровно одно",
  formatEther((await balanceOf(MERCHANT)) - merchantBeforeRace),
);

const payee = await newAgent(`payee-${suffix}`);
const invoice = await call("/invoices", {
  method: "POST",
  apiKey: payee.apiKey,
  body: {valueEth: "0.05", memo: "гонка по счёту"},
});
ok(invoice.status === 201, "счёт выставлен");

const invoiceBefore = await balanceOf(invoice.body.to);
const bothPay = await Promise.all([
  call("/agents/me/transactions", {method: "POST", apiKey: racer.apiKey, body: {invoiceId: invoice.body.id}}),
  call("/agents/me/transactions", {method: "POST", apiKey: agent.apiKey, body: {invoiceId: invoice.body.id}}),
]);
const invoicePaid = bothPay.filter((r) => r.status === 201).length;
ok(invoicePaid <= 1, "счёт оплачен не больше одного раза", `успехов: ${invoicePaid}`);
const invoiceDelta = (await balanceOf(invoice.body.to)) - invoiceBefore;
ok(
  invoiceDelta === parseEther(invoicePaid === 1 ? "0.05" : "0"),
  "по счёту списано ровно столько, сколько успешных оплат",
  formatEther(invoiceDelta),
);

const invoiceState = await call(`/invoices/${invoice.body.id}`);
// При ненулевой глубине счёт остаётся захваченным (`paying`), пока платёж дозревает:
// отпустить его раньше значило бы разрешить вторую оплату того же счёта.
const expectedInvoice =
  invoicePaid === 1 ? (DEPTH === 0 ? ["paid"] : ["paid", "paying"]) : ["open"];
ok(
  expectedInvoice.includes(invoiceState.body.status),
  "статус счёта соответствует исходу",
  invoiceState.body.status,
);

// ---------------------------------------------------------------------------
section("6. Счёт: повтор и просрочка");
// ---------------------------------------------------------------------------
if (invoicePaid === 1) {
  const again = await call("/agents/me/transactions", {
    method: "POST",
    apiKey: racer.apiKey,
    body: {invoiceId: invoice.body.id},
  });
  ok(again.status === 409, "повторная оплата счёта отклонена", `${again.status}`);
}

const expiring = await call("/invoices", {
  method: "POST",
  apiKey: payee.apiKey,
  body: {valueEth: "0.01", ttlSeconds: 1},
});
await new Promise((resolve) => setTimeout(resolve, 1500));
const expiredPay = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: racer.apiKey,
  body: {invoiceId: expiring.body.id},
});
ok(expiredPay.status === 410, "просроченный счёт не оплачивается", `${expiredPay.status}`);

// ---------------------------------------------------------------------------
section("7. Режим REMOTE: ключа у платформы нет");
// ---------------------------------------------------------------------------
const remoteOwner = privateKeyToAccount(generatePrivateKey());
let impostor = null;
let signRequests = 0;

const signer = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", async () => {
    signRequests++;
    const {userOpHash} = JSON.parse(raw);
    const account = impostor ?? remoteOwner;
    response.writeHead(200, {"content-type": "application/json"});
    response.end(JSON.stringify({signature: await account.sign({hash: userOpHash})}));
  });
});
await new Promise((resolve) => signer.listen(4455, "127.0.0.1", resolve));

const remote = await call("/agents", {
  method: "POST",
  body: {
    handle: `remote-${suffix}`,
    mode: "AUTONOMOUS_ENTITY",
    owner: remoteOwner.address,
    signerUrl: "http://127.0.0.1:4455/sign",
  },
});
ok(remote.body.signerMode === "REMOTE", "режим REMOTE", remote.body.signerMode);

await call("/agents/me/deposit", {method: "POST", apiKey: remote.body.apiKey, body: {valueEth: "2"}});
const remoteBefore = await balanceOf(MERCHANT);
const remotePaid = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: remote.body.apiKey,
  key: uid(),
  body: {to: MERCHANT, valueEth: "0.15"},
});
ok(remotePaid.status === 201, "платёж подписан агентом", `${remotePaid.status}: ${remotePaid.body.error ?? ""}`);
ok((await balanceOf(MERCHANT)) - remoteBefore === parseEther("0.15"), "получатель получил 0.15 ETH");
ok(signRequests === 1, "подпись спрошена один раз", String(signRequests));

impostor = privateKeyToAccount(generatePrivateKey());
const spoofed = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: remote.body.apiKey,
  key: uid(),
  body: {to: MERCHANT, valueEth: "0.1"},
});
ok(spoofed.status >= 400, "подпись чужого ключа отвергнута", `${spoofed.status}`);
signer.close();

// ---------------------------------------------------------------------------
section("8. Кран и валидация ввода");
// ---------------------------------------------------------------------------
const faucetAgent = await newAgent(`faucet-${suffix}`);
let faucetRefused = null;
for (let i = 0; i < 5 && !faucetRefused; i++) {
  const grant = await call("/agents/me/deposit", {
    method: "POST",
    apiKey: faucetAgent.apiKey,
    body: {valueEth: "10"},
  });
  if (grant.status !== 200) faucetRefused = grant;
}
ok(faucetRefused?.status === 429, "суточный лимит крана срабатывает", `${faucetRefused?.status}: ${faucetRefused?.body.error}`);

const negative = await call("/agents/me/transactions", {
  method: "POST",
  apiKey: agent.apiKey,
  key: uid(),
  body: {to: MERCHANT, valueEth: "-1"},
});
ok(negative.status === 400, "отрицательная сумма — 400", `${negative.status}`);

const badTtl = await call("/invoices", {
  method: "POST",
  apiKey: payee.apiKey,
  body: {valueEth: "0.01", ttlSeconds: "не число"},
});
ok(badTtl.status === 400, "нечисловой ttlSeconds — 400", `${badTtl.status}`);

const badPeriod = await call("/agents/me/rules", {
  method: "PUT",
  apiKey: agent.apiKey,
  body: {limitEth: "1", periodSeconds: "не число"},
});
ok(badPeriod.status === 400, "нечисловой periodSeconds — 400", `${badPeriod.status}`);

// ---------------------------------------------------------------------------
section("9. Дубль регистрации: один владелец — несколько кошельков");
// ---------------------------------------------------------------------------
// Реестр запрещает регистрировать один и тот же account дважды. Соль выводится из
// имени, поэтому второй агент того же владельца с теми же правилами получает другой
// адрес и регистрируется штатно — без этого запрет ломал бы обычный сценарий.
const shared = privateKeyToAccount(generatePrivateKey());
const first = await call("/agents", {
  method: "POST",
  body: {handle: `twin-a-${suffix}`, mode: "AUTONOMOUS_ENTITY", owner: shared.address},
});
const second = await call("/agents", {
  method: "POST",
  body: {handle: `twin-b-${suffix}`, mode: "AUTONOMOUS_ENTITY", owner: shared.address},
});
ok(first.status === 201 && second.status === 201, "два кошелька одного владельца создаются", `${first.status}/${second.status}`);
ok(first.body.account !== second.body.account, "адреса разные", `${first.body.account?.slice(0, 10)} ≠ ${second.body.account?.slice(0, 10)}`);

const sameHandle = await call("/agents", {
  method: "POST",
  body: {handle: `twin-a-${suffix}`, mode: "AUTONOMOUS_ENTITY", owner: shared.address},
});
ok(sameHandle.status === 409, "то же имя — конфликт", `${sameHandle.status}`);

// ---------------------------------------------------------------------------
section("10. Реорг: подтверждённый платёж не остаётся подтверждённым навсегда");
// ---------------------------------------------------------------------------
// Стенд по умолчанию работает с CONFIRMATION_BLOCKS=0 (на anvil реорга не бывает),
// поэтому проверка имеет смысл только когда сервер поднят с ненулевой глубиной.
if (DEPTH === 0) {
  console.log("  ··   пропущено: запустите сервер с CONFIRMATION_BLOCKS=2");
} else {
  const victim = await newAgent(`reorg-${suffix}`);
  await call("/agents/me/deposit", {method: "POST", apiKey: victim.apiKey, body: {valueEth: "3"}});
  await grantSessionKey(victim, "1");

  // Снимок до платежа: откат к нему выкинет блок с транзакцией бандлера — ровно то,
  // что делает реорг.
  const snapshot = await rpc("evm_snapshot");

  const before = await call("/agents/me/transactions", {
    method: "POST",
    apiKey: victim.apiKey,
    key: `reorg-${suffix}`,
    body: {to: MERCHANT, valueEth: "0.1"},
  });
  ok(before.body.status === "submitted", "платёж ждёт подтверждений, а не подтверждён сразу", before.body.status);

  for (let i = 0; i < DEPTH + 1; i++) await rpc("evm_mine");
  const matured = await call(`/agents/me/payments/${before.body.id}`, {apiKey: victim.apiKey});
  ok(matured.body.status === "confirmed", "после нужной глубины платёж подтверждён", matured.body.status);

  const history = await call("/agents/me/transactions", {apiKey: victim.apiKey});
  ok(history.body.transactions.length === 1, "трата в публичном логе", String(history.body.transactions.length));

  await rpc("evm_revert", [snapshot]);
  for (let i = 0; i < DEPTH + 1; i++) await rpc("evm_mine");

  const afterReorg = await call(`/agents/me/payments/${before.body.id}`, {apiKey: victim.apiKey});
  ok(
    afterReorg.body.status === "submitted",
    "после реорга платёж вернулся в submitted, а не остался confirmed",
    afterReorg.body.status,
  );

  const historyAfter = await call("/agents/me/transactions", {apiKey: victim.apiKey});
  ok(
    historyAfter.body.transactions.length === 0,
    "осиротевшая трата убрана из публичного лога",
    String(historyAfter.body.transactions.length),
  );
}

// ---------------------------------------------------------------------------
section("11. Режим SERVER_KEY закрыт флагом");
// ---------------------------------------------------------------------------
// Проверка имеет смысл только когда сервер поднят с ALLOW_SERVER_KEY_MODE=false:
// это состояние публичной сети, где платформа не имеет права держать главный ключ.
if (process.env.ALLOW_SERVER_KEY_MODE === "false") {
  const withoutOwner = await call("/agents", {
    method: "POST",
    body: {handle: `srv-${suffix}`, mode: "AUTONOMOUS_ENTITY"},
  });
  ok(withoutOwner.status === 400, "регистрация без owner отклонена", `${withoutOwner.status}`);
  ok(
    Boolean(withoutOwner.body.requestId),
    "в ответе есть requestId для разбора по логам",
    withoutOwner.body.requestId,
  );
} else {
  console.log("  ··   пропущено: запустите сервер с ALLOW_SERVER_KEY_MODE=false");
}

console.log(failures ? `\n${failures} проверок провалено` : "\nвсе проверки пройдены");
process.exit(failures ? 1 : 0);
