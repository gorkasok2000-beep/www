// ---------------------------------------------------------------------
// Состояние и его хранение
// ---------------------------------------------------------------------

/**
 * Единственный источник правды — `state.wallets`. И кабинет агента, и админ-панель,
 * и публичная витрина читают один и тот же набор кошельков, поэтому заморозка из
 * админки сразу видна владельцу, а не «где-то отдельно».
 *
 * Кошельки и keystore переживают перезагрузку (localStorage), сессия — нет:
 * после обновления страницы кабинет снова просит парольную фразу. Это не забывчивость,
 * а смысл схемы — доступ даёт расшифрованный ключ, а не запомненный флаг.
 */

const STORAGE_KEY = "synth.demo.v3";
const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** Комиссия за операцию: чтобы баланс вёл себя как на настоящей сети. */
const GAS_FEE = 210000000000000n;

const state = {
  wallets: {},
  keystores: {},
  feed: [],
  session: null,
  admin: false,
  adminLog: [],
  live: true,

  // Черновики форм и разовые сообщения — в localStorage не уезжают.
  reg: {
    step: "mode",
    mode: null,
    handle: "",
    passphrase: "",
    passphrase2: "",
    limitEth: "",
    periodSeconds: 86400,
    whitelistEnabled: false,
    whitelist: "",
    pending: false,
    error: null,
    created: null,
  },
  login: {handle: "", passphrase: "", accessKey: "", mode: "keystore", pending: false, error: null},
  adminForm: {user: "", password: "", error: null, pending: false, query: "", amount: "1"},
  form: {to: "", amountEth: "", target: "", budgetEth: "0.5"},
  rules: {limitEth: "", periodSeconds: 86400, whitelistEnabled: false},
  revealedKey: null,
  notice: null,
  error: null,
};

// ---------------------------------------------------------------------
// Сериализация: BigInt и даты JSON не переживает сам по себе
// ---------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const replacer = (_key, value) =>
  typeof value === "bigint" ? {__bigint: value.toString()} : value;

function reviver(_key, value) {
  if (value && typeof value === "object" && typeof value.__bigint === "string") {
    return BigInt(value.__bigint);
  }
  if (typeof value === "string" && ISO_DATE.test(value)) {
    return new Date(value);
  }
  return value;
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        {wallets: state.wallets, keystores: state.keystores, feed: state.feed.slice(0, 40)},
        replacer,
      ),
    );
  } catch {
    // Приватный режим или переполненное хранилище: демо продолжает работать в памяти.
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw, reviver);
    if (!data?.wallets || Object.keys(data.wallets).length === 0) return false;

    state.wallets = data.wallets;
    state.keystores = data.keystores || {};
    state.feed = data.feed || [];
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Стартовые данные
// ---------------------------------------------------------------------

function makeWallet(overrides) {
  return {
    handle: "",
    mode: "AUTONOMOUS_ENTITY",
    account: randomAddress(),
    owner: randomAddress(),
    custodian: null,
    balanceWei: 0n,
    gasDepositWei: 0n,
    frozen: false,
    rules: {limitWei: 0n, periodSeconds: 0n, whitelistEnabled: false},
    whitelist: [],
    win: {startedAt: 0n, spent: 0n},
    txs: [],
    // Попытки оплаты, включая неудавшиеся, — то, что в приложении хранит таблица Payment.
    payments: [],
    apiKeys: [],
    // Ключ ограниченного доступа, выданный платформе; null — платформе платить нечем.
    sessionKey: null,
    createdAt: new Date(),
    demo: false,
    ...overrides,
  };
}

/** Витрина и админка не должны быть пустыми при первом открытии. */
function seedDemoData() {
  const presets = [
    ["vega", "AUTONOMOUS_ENTITY", "3.4", 38, null],
    ["kepler", "HUMAN_CUSTODIAN", "1.2", 96, {limitEth: "0.5", period: 86400n}],
    ["nomad", "AUTONOMOUS_ENTITY", "0.8", 140, null],
    ["atlas", "HUMAN_CUSTODIAN", "2.1", 210, {limitEth: "0.25", period: 3600n}],
    ["orion-prime", "AUTONOMOUS_ENTITY", "5.6", 320, null],
  ];

  state.wallets = {};
  for (const [handle, mode, balance, minutes, rules] of presets) {
    state.wallets[handle] = makeWallet({
      handle,
      mode,
      balanceWei: parseEth(balance),
      gasDepositWei: parseEth("0.002"),
      createdAt: minutesAgo(minutes),
      demo: true,
      rules: rules
        ? {limitWei: parseEth(rules.limitEth), periodSeconds: rules.period, whitelistEnabled: false}
        : {limitWei: 0n, periodSeconds: 0n, whitelistEnabled: false},
      // Показательным агентам ключ уже выдан — иначе витрина выглядела бы так, будто
      // никто из них не может заплатить.
      sessionKey: {
        address: randomAddress(),
        budgetWei: parseEth("1"),
        spentWei: parseEth("0.35"),
        validUntil: Date.now() + 20 * 60 * 60 * 1000,
        issuedAt: minutesAgo(minutes),
      },
    });
  }

  const amounts = ["0.12", "0.4", "0.031", "0.25", "0.08", "0.5", "0.017", "0.09", "0.22", "0.06"];
  const handles = presets.map(([handle]) => handle);

  // Лента и история кошелька — одно и то же событие, поэтому запись попадает в оба
  // места: иначе витрина показывала бы трату у агента с нулём транзакций.
  state.feed = amounts.map((amount, i) => {
    const handle = handles[i % handles.length];
    const valueWei = parseEth(amount);
    const timestamp = minutesAgo(3 + i * 7);
    const to = randomAddress();
    const txHash = randomTxHash();

    state.wallets[handle].txs.push({
      to,
      valueWei,
      txHash,
      blockNumber: String(1000 + i * 3),
      timestamp,
    });

    return {
      handle,
      mode: state.wallets[handle].mode,
      to: shortAddress(to),
      valueWei,
      txHash,
      timestamp,
    };
  });

  for (const handle of handles) {
    state.wallets[handle].txs.sort((a, b) => b.timestamp - a.timestamp);
  }
}

function resetDemoData() {
  state.session = null;
  state.keystores = {};
  state.adminLog = [];
  seedDemoData();
  persist();
}

// ---------------------------------------------------------------------
// Доступ к данным
// ---------------------------------------------------------------------

const wallet = () => (state.session ? state.wallets[state.session] : null);
const allWallets = () => Object.values(state.wallets).sort((a, b) => b.createdAt - a.createdAt);
const activeApiKeys = (w) => w.apiKeys.filter((key) => !key.revoked);

// ---------------------------------------------------------------------
// Правила трат — перенос SpendingRules.sol и AgentAccount._authorizeSpend
// ---------------------------------------------------------------------

/** Остаток лимита в текущем окне; null означает «без ограничения». */
function spendingRemaining(w) {
  const {limitWei, periodSeconds} = w.rules;
  if (limitWei === 0n) return null;
  if (periodSeconds === 0n) return limitWei;

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (w.win.startedAt === 0n || now - w.win.startedAt >= periodSeconds) return limitWei;
  return limitWei > w.win.spent ? limitWei - w.win.spent : 0n;
}

/**
 * Полная копия проверок контракта. Состояние окна меняется только при успехе —
 * в Solidity это обеспечивает revert, здесь приходится считать до записи.
 */
function authorizeSpend(w, to, valueWei) {
  if (w.frozen) {
    throw new DemoError("Кошелёк заморожен администратором.");
  }
  if (w.rules.whitelistEnabled && !w.whitelist.includes(to.toLowerCase())) {
    throw new DemoError(`Получатель ${to} не в whitelist.`);
  }

  const {limitWei, periodSeconds} = w.rules;
  if (limitWei === 0n) return;

  if (periodSeconds === 0n) {
    if (valueWei > limitWei) {
      throw new DemoError(
        `Превышен лимит трат: запрошено ${formatEth(valueWei)} ETH, ` +
          `доступно ${formatEth(limitWei)} ETH.`,
      );
    }
    return;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  let startedAt = w.win.startedAt;
  let spent = w.win.spent;
  if (startedAt === 0n || now - startedAt >= periodSeconds) {
    startedAt = now;
    spent = 0n;
  }

  const left = limitWei > spent ? limitWei - spent : 0n;
  if (valueWei > left) {
    throw new DemoError(
      `Превышен лимит трат: запрошено ${formatEth(valueWei)} ETH, ` +
        `доступно ${formatEth(left)} ETH.`,
    );
  }

  w.win.startedAt = startedAt;
  w.win.spent = spent + valueWei;
}

// ---------------------------------------------------------------------
// Ключи ограниченного доступа — перенос SessionKeys.sol
// ---------------------------------------------------------------------

/** Ключ выдан и не просрочен. */
function sessionKeyLive(w) {
  return Boolean(w.sessionKey) && w.sessionKey.validUntil > Date.now();
}

/** Сколько платформе ещё разрешено потратить; null — ключа нет. */
function sessionKeyRemaining(w) {
  if (!sessionKeyLive(w)) return null;
  const {budgetWei, spentWei} = w.sessionKey;
  return budgetWei > spentWei ? budgetWei - spentWei : 0n;
}

/**
 * Владелец выдаёт платформе ключ с бюджетом и сроком.
 *
 * Вечных ключей не бывает и нулевого бюджета тоже — так же, как в контракте:
 * `registerSessionKey` отвергает и то, и другое.
 */
function issueSessionKey(w, budgetWei, ttlSeconds = 86400) {
  if (budgetWei === 0n) {
    throw new DemoError("Бюджет ключа должен быть больше нуля.");
  }

  w.sessionKey = {
    address: randomAddress(),
    budgetWei,
    spentWei: 0n,
    validUntil: Date.now() + ttlSeconds * 1000,
    issuedAt: new Date(),
  };
  persist();
  return w.sessionKey;
}

/** Отзыв доступен и владельцу, и самой платформе — как в контракте. */
function revokeSessionKey(w) {
  w.sessionKey = null;
  persist();
}

/** Проверка границ ключа. Списание происходит отдельно, после успеха платежа. */
function authorizeSessionKey(w, valueWei) {
  if (!w.sessionKey) {
    throw new DemoError(
      "У платформы нет ключа для этого кошелька — выпустите его в карточке «Подпись операций».",
    );
  }
  if (w.sessionKey.validUntil <= Date.now()) {
    throw new DemoError("Срок действия ключа платформы истёк — выпустите новый.");
  }

  const left = sessionKeyRemaining(w);
  if (valueWei > left) {
    throw new DemoError(
      `Превышен бюджет ключа платформы: запрошено ${formatEth(valueWei)} ETH, ` +
        `осталось ${formatEth(left)} ETH. Средства на кошельке при этом есть — ` +
        `границу задал владелец при выдаче ключа.`,
    );
  }
}

// ---------------------------------------------------------------------
// Операции над кошельками
// ---------------------------------------------------------------------

function creditWallet(handle, valueWei) {
  const w = state.wallets[handle];
  if (!w) throw new DemoError(`Агент «${handle}» не найден.`);
  w.balanceWei += valueWei;
  persist();
}

function setFrozen(handle, frozen) {
  const w = state.wallets[handle];
  if (!w) throw new DemoError(`Агент «${handle}» не найден.`);
  w.frozen = frozen;
  persist();
}

/**
 * Оплата от имени агента.
 *
 * Записывается любая попытка — и удавшаяся, и нет. Это то же, что делает таблица
 * `Payment` в приложении: агенту важно не только «получилось», но и «почему нет».
 *
 * `idempotencyKey` обязателен, как и в API: повтор с тем же ключом возвращает первый
 * результат и второй траты не создаёт.
 */
function sendPayment(w, to, valueWei, idempotencyKey) {
  if (!idempotencyKey) {
    throw new DemoError("Нужен ключ идемпотентности: без него повтор стал бы вторым платежом.");
  }

  const seen = w.payments.find((payment) => payment.idempotencyKey === idempotencyKey);
  if (seen) {
    return {...seen, replayed: true};
  }

  try {
    return recordPayment(w, to, valueWei, idempotencyKey);
  } catch (cause) {
    w.payments.unshift({
      idempotencyKey,
      to,
      valueWei,
      status: "failed",
      failureReason: cause.message,
      txHash: null,
      timestamp: new Date(),
    });
    persist();
    throw cause;
  }
}

function recordPayment(w, to, valueWei, idempotencyKey) {
  if (!isAddress(to)) {
    throw new DemoError("Поле «Адрес получателя» должно быть Ethereum-адресом.");
  }
  if (valueWei === 0n) {
    throw new DemoError("Укажите сумму больше нуля.");
  }
  if (valueWei + GAS_FEE > w.balanceWei) {
    throw new DemoError("Недостаточно средств на кошельке.");
  }

  // Две независимые границы: бюджет ключа платформы и правила кошелька.
  authorizeSessionKey(w, valueWei);
  authorizeSpend(w, to, valueWei);

  w.sessionKey.spentWei += valueWei;
  w.balanceWei -= valueWei + GAS_FEE;
  w.gasDepositWei += GAS_FEE / 8n;

  const tx = {
    to,
    valueWei,
    txHash: randomTxHash(),
    blockNumber: String(1000 + w.txs.length * 3),
    timestamp: new Date(),
  };
  w.txs.unshift(tx);
  w.payments.unshift({
    idempotencyKey,
    to,
    valueWei,
    status: "confirmed",
    failureReason: null,
    txHash: tx.txHash,
    timestamp: tx.timestamp,
  });

  state.feed.unshift({
    handle: w.handle,
    mode: w.mode,
    to: shortAddress(to),
    valueWei,
    txHash: tx.txHash,
    timestamp: tx.timestamp,
  });
  state.feed = state.feed.slice(0, 40);

  // Ключ, которым агент ходит в API, «использовался» — отражаем это в кабинете.
  const key = activeApiKeys(w)[0];
  if (key) key.lastUsedAt = new Date();

  persist();
  return tx;
}
