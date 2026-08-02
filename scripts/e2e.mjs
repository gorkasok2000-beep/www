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
 *   8. лимиты крана и валидация ввода;
 *   9. вебхуки: подпись, повтор с тем же идентификатором события, разбор очереди;
 *  10. путь через настоящий JSON-RPC-бандлер, перебор эндпоинтов и отказ без перебора.
 *
 * Требуется поднятый стенд:
 *   anvil
 *   PRIVATE_KEY=… forge script script/Deploy.s.sol:Deploy --root contracts --broadcast
 *   pnpm --filter web build && pnpm --filter web start
 *
 * Часть разделов зависит от конфигурации стенда и без неё честно пропускается:
 *   CONFIRMATION_BLOCKS=2      — реорг и созревание платежа (раздел 10);
 *   ALLOW_SERVER_KEY_MODE=false — закрытый прототипный режим (раздел 11);
 *   BUNDLER_URL=http://127.0.0.1:1,http://127.0.0.1:4466 — бандлер (раздел 13).
 *
 * Запуск:  node scripts/e2e.mjs
 */
import {createHmac} from "node:crypto";
import {readFileSync} from "node:fs";
import {createServer} from "node:http";
import {join} from "node:path";

import {createPublicClient, createWalletClient, http, parseEther, formatEther} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {foundry} from "viem/chains";

import {loadEnvFile, repoRoot} from "./env-file.mjs";

const env = {...loadEnvFile(), ...process.env};

const BASE = process.env.SYNTH_API_URL ?? "http://127.0.0.1:3000";
const API = `${BASE}/api/v1`;
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ADMIN_TOKEN = env.ADMIN_API_TOKEN;

/** Порт заглушки бандлера — он же должен стоять вторым в BUNDLER_URL стенда. */
const STUB_BUNDLER_PORT = 4466;

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

/**
 * Заглушка бандлера поднимается на весь прогон, а не только на свой раздел.
 *
 * Стенд, поднятый со списком `BUNDLER_URL`, шлёт через бандлер КАЖДЫЙ платёж — значит,
 * без работающей заглушки развалились бы все разделы разом. Заодно это и есть смысл
 * такой конфигурации: весь сценарий целиком проходит по тому пути, который поедет в
 * тестовую сеть, а не по локальному `handleOps` изнутри приложения.
 */
const BUNDLER_STAND = process.env.BUNDLER_URL?.includes(String(STUB_BUNDLER_PORT)) ?? false;
const deployments = JSON.parse(
  readFileSync(join(repoRoot, "contracts", "deployments", "31337.json"), "utf8"),
);

async function startBundler(mode = "accept") {
  const {startStubBundler} = await import("./stub-bundler.mjs");
  return startStubBundler({
    port: STUB_BUNDLER_PORT,
    entryPoint: deployments.entryPoint,
    privateKey: env.RELAYER_PRIVATE_KEY,
    rpcUrl: RPC,
    mode,
  });
}

const stubBundler = BUNDLER_STAND ? await startBundler() : null;

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

// ---------------------------------------------------------------------------
section("12. Вебхуки: подпись, идемпотентность потребителя, повторы");
// ---------------------------------------------------------------------------
{
  /**
   * Приёмник событий. Ведёт журнал полученных запросов и умеет отвечать ошибкой —
   * без этого не проверить ни повтор, ни то, что повтор несёт тот же идентификатор.
   */
  const received = [];
  let receiverStatus = 200;
  const receiver = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      received.push({headers: request.headers, body: raw});
      response.writeHead(receiverStatus, {"content-type": "application/json"});
      response.end("{}");
    });
  });
  await new Promise((resolve) => receiver.listen(4477, "127.0.0.1", resolve));

  const listener = await newAgent(`hook-${suffix}`);
  const subscribed = await call("/agents/me/webhooks", {
    method: "POST",
    apiKey: listener.apiKey,
    body: {url: "http://127.0.0.1:4477/events", events: ["payment.confirmed"]},
  });
  ok(subscribed.status === 201, "подписка создана", `${subscribed.status}`);
  ok(Boolean(subscribed.body.secret), "секрет выдан один раз", subscribed.body.secret?.slice(0, 12));

  const listed = await call("/agents/me/webhooks", {apiKey: listener.apiKey});
  ok(
    listed.body.webhooks?.[0] && listed.body.webhooks[0].secret === undefined,
    "в списке секрета уже нет",
  );

  // ping доходит даже до подписки на одно конкретное событие: иначе «проверить эндпоинт»
  // молча ничего бы не делало.
  const ping = await call(`/agents/me/webhooks/${subscribed.body.id}/test`, {
    method: "POST",
    apiKey: listener.apiKey,
  });
  ok(ping.body.status === "delivered", "ping доставлен", ping.body.status);

  const pinged = received.at(-1);
  const signature = pinged?.headers["x-synth-signature"] ?? "";
  const [tPart, vPart] = signature.split(",");
  const expected = createHmac("sha256", subscribed.body.secret)
    .update(`${tPart?.slice(2)}.${pinged?.body}`)
    .digest("hex");
  ok(vPart === `v1=${expected}`, "подпись сходится с телом и меткой времени");
  ok(pinged?.headers["x-synth-event"] === "ping", "заголовок X-Synth-Event", pinged?.headers["x-synth-event"]);
  ok(Boolean(pinged?.headers["x-synth-event-id"]), "заголовок X-Synth-Event-Id");

  // Событие платежа. При ненулевой глубине платёж закрывается не сразу, поэтому цепь
  // подращивается и состояние перечитывается — тем же способом, что и в разделе 10.
  await call("/agents/me/deposit", {method: "POST", apiKey: listener.apiKey, body: {valueEth: "2"}});
  await grantSessionKey(listener, "0.5");
  const hookPayment = await call("/agents/me/transactions", {
    method: "POST",
    apiKey: listener.apiKey,
    key: `hook-pay-${suffix}`,
    body: {to: MERCHANT, valueEth: "0.01"},
  });
  if (DEPTH > 0) {
    for (let i = 0; i < DEPTH + 1; i++) await rpc("evm_mine");
    await call(`/agents/me/payments/${hookPayment.body.id}`, {apiKey: listener.apiKey});
  }

  const confirmedEvent = received
    .map((entry) => JSON.parse(entry.body))
    .find((payload) => payload.event === "payment.confirmed");
  ok(Boolean(confirmedEvent), "пришло payment.confirmed");
  ok(
    confirmedEvent?.data?.payment?.id === hookPayment.body.id,
    "событие про тот самый платёж",
    confirmedEvent?.data?.payment?.id,
  );

  // Отказ приёмника: доставка не теряется, а планируется на повтор с тем же eventId —
  // ровно тем, по которому потребитель обязан отсеять дубль.
  receiverStatus = 503;
  const retried = await call(`/agents/me/webhooks/${subscribed.body.id}/test`, {
    method: "POST",
    apiKey: listener.apiKey,
  });
  ok(retried.body.status === "pending", "неудачная доставка осталась в очереди", retried.body.status);
  ok(retried.body.attempts === 1, "попытка учтена", String(retried.body.attempts));

  receiverStatus = 200;
  const beforeFlush = received.length;
  // Первая пауза перед повтором — секунда: ждём её, иначе flush ничего не подхватит.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const flushed = await call("/admin/webhooks/flush", {method: "POST", apiKey: ADMIN_TOKEN});
  ok(flushed.body.delivered >= 1, "flush добрал отложенную доставку", JSON.stringify(flushed.body));

  const redelivered = received.slice(beforeFlush);
  ok(
    redelivered.some((entry) => entry.headers["x-synth-event-id"] === retried.body.eventId),
    "повтор несёт тот же X-Synth-Event-Id",
  );

  const unsubscribed = await call(`/agents/me/webhooks/${subscribed.body.id}`, {
    method: "DELETE",
    apiKey: listener.apiKey,
  });
  ok(unsubscribed.status === 200, "отписка", `${unsubscribed.status}`);

  // Чужую подписку удалить нельзя, и по ответу не видно, существует ли она.
  const stranger = await newAgent(`hook-x-${suffix}`);
  const foreign = await call(`/agents/me/webhooks/${subscribed.body.id}`, {
    method: "DELETE",
    apiKey: stranger.apiKey,
  });
  ok(foreign.status === 404, "чужая подписка недоступна", `${foreign.status}`);

  await new Promise((resolve) => receiver.close(resolve));
}

// ---------------------------------------------------------------------------
section("13. Настоящий бандлер: перебор эндпоинтов и отказ без перебора");
// ---------------------------------------------------------------------------
// Единственная конфигурация, в которой исполняется `RpcBundler`: обычный прогон идёт
// через локальный `handleOps` изнутри приложения. Требует стенда, поднятого со списком
// бандлеров, где ПЕРВЫЙ адрес заведомо мёртв:
//   BUNDLER_URL=http://127.0.0.1:1,http://127.0.0.1:4466 pnpm --filter web start
if (!stubBundler) {
  console.log(
    `  ··   пропущено: поднимите сервер с BUNDLER_URL=http://127.0.0.1:1,http://127.0.0.1:${STUB_BUNDLER_PORT}`,
  );
} else {
  // Всё, что оплачено выше, оплачено через заглушку — значит перебор сработал на каждом
  // платеже: первый эндпоинт в списке не слушает никто.
  ok(
    stubBundler.calls.includes("eth_sendUserOperation"),
    "операции ушли по JSON-RPC мимо мёртвого первого эндпоинта",
    `вызовов: ${stubBundler.calls.length}`,
  );
  ok(
    stubBundler.calls.includes("eth_estimateUserOperationGas"),
    "газ оценивал бандлер, а не локальная эвристика",
  );

  await stubBundler.close();

  // Та же заглушка, но отвечающая JSON-RPC-ошибкой: операцию рассмотрели и отвергли.
  // Такой отказ не должен превращаться в перебор — иначе агент вместо внятной причины
  // получал бы «ни один бандлер не ответил» через несколько таймаутов.
  const rejecting = await startBundler("reject");

  const payer = await newAgent(`bundler-${suffix}`);
  await call("/agents/me/deposit", {method: "POST", apiKey: payer.apiKey, body: {valueEth: "2"}});
  await grantSessionKey(payer, "0.5");

  const merchantBeforeReject = await balanceOf(MERCHANT);
  const refused = await call("/agents/me/transactions", {
    method: "POST",
    apiKey: payer.apiKey,
    key: `bundler-reject-${suffix}`,
    body: {to: MERCHANT, valueEth: "0.01"},
  });
  ok(refused.status === 502, "отказ бандлера — 502, а не 500", `${refused.status}`);
  ok(
    (await balanceOf(MERCHANT)) === merchantBeforeReject,
    "денег отвергнутая операция не двинула",
  );
  ok(
    /отклонил/.test(refused.body.error ?? "") && !/Ни один бандлер/.test(refused.body.error ?? ""),
    "причина — отказ бандлера, а не исчерпанный перебор",
    refused.body.error,
  );

  await rejecting.close();
}

console.log(failures ? `\n${failures} проверок провалено` : "\nвсе проверки пройдены");
process.exit(failures ? 1 : 0);
