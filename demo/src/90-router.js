// ---------------------------------------------------------------------
// Маршрутизация, отрисовка и действия
// ---------------------------------------------------------------------

const CABINET_ROUTES = ["#/dashboard", "#/transactions", "#/settings", "#/api-keys"];

function currentRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  return "#" + hash.split("#")[0];
}

/** Якорь лендинга: во второй решётке хеша, `#/#manifest`. */
const currentAnchor = () => location.hash.split("#")[2] || null;

let lastRoute = null;

/**
 * Перед подменой разметки запоминаем, где стоял курсор, и возвращаем его назад.
 * Без этого живой поиск в админке терял бы фокус на каждом символе.
 */
function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.dataset?.model) return null;
  return {model: el.dataset.model, start: el.selectionStart, end: el.selectionEnd};
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const el = document.querySelector(`[data-model="${snapshot.model}"]`);
  if (!el) return;
  el.focus();
  try {
    el.setSelectionRange(snapshot.start, snapshot.end);
  } catch {
    // У некоторых типов полей выделения нет — фокуса достаточно.
  }
}

function render() {
  const route = currentRoute();

  if (CABINET_ROUTES.includes(route) && !state.session) {
    location.hash = "#/login";
    return;
  }
  if (route === "#/login" && state.session) {
    location.hash = "#/dashboard";
    return;
  }

  const routeChanged = route !== lastRoute;
  const snapshot = routeChanged ? null : captureFocus();

  let body;
  if (route === "#/admin") {
    body = state.admin ? adminPanelPage() : adminLoginPage();
  } else if (CABINET_ROUTES.includes(route)) {
    const page =
      route === "#/dashboard"
        ? dashboardPage()
        : route === "#/transactions"
          ? transactionsPage()
          : route === "#/api-keys"
            ? apiKeysPage()
            : settingsPage();
    body = cabinetShell(page, route);
  } else {
    const page =
      route === "#/register"
        ? registerPage()
        : route === "#/login"
          ? loginPage()
          : route === "#/showcase"
            ? showcasePage()
            : landing();
    body = `<div class="flex min-h-screen flex-col">
      ${siteHeader()}
      <main class="flex-1">${page}</main>
      ${siteFooter()}
    </div>`;
  }

  // Анимация появления — только при смене маршрута. Иначе список транзакций
  // переигрывал бы её после каждого платежа.
  document.getElementById("app").innerHTML = routeChanged
    ? `<div class="sw-page">${body}</div>`
    : body;

  restoreFocus(snapshot);
  lastRoute = route;
}

/** Прокрутка после смены хеша: к якорю, если он есть, иначе наверх. */
function scrollAfterNavigation() {
  const anchor = currentAnchor();
  requestAnimationFrame(() => {
    if (anchor) {
      document.getElementById(anchor)?.scrollIntoView({behavior: "smooth", block: "start"});
    } else {
      window.scrollTo({top: 0, behavior: "auto"});
    }
  });
}

// ---------------------------------------------------------------------
// Регистрация и вход
// ---------------------------------------------------------------------

async function submitRegistration() {
  const reg = state.reg;
  const handle = reg.handle.trim();

  if (!/^[a-z0-9][a-z0-9-]{1,30}$/i.test(handle)) {
    reg.error = "Имя агента: от 2 до 31 символа, латиница, цифры и дефис.";
    return render();
  }
  if (state.wallets[handle]) {
    reg.error = `Имя «${handle}» уже занято.`;
    return render();
  }
  if (reg.passphrase.length < 8) {
    reg.error = "Парольная фраза должна быть не короче 8 символов.";
    return render();
  }
  if (reg.passphrase !== reg.passphrase2) {
    reg.error = "Парольные фразы не совпадают.";
    return render();
  }

  const custodial = reg.mode === "HUMAN_CUSTODIAN";
  let limitWei = 0n;
  try {
    limitWei = custodial && reg.limitEth.trim() ? parseEth(reg.limitEth) : 0n;
  } catch (cause) {
    reg.error = cause.message;
    return render();
  }

  reg.pending = true;
  reg.error = null;
  render();

  try {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const address = await addressFromSecret(secret);
    const keystore = await createKeystore(secret, reg.passphrase, {
      handle,
      mode: reg.mode,
      address,
    });
    const apiKey = issueApiKey();

    state.wallets[handle] = makeWallet({
      handle,
      mode: reg.mode,
      account: address,
      custodian: custodial ? randomAddress() : null,
      rules: {
        limitWei,
        periodSeconds: custodial ? BigInt(reg.periodSeconds) : 0n,
        whitelistEnabled: custodial ? reg.whitelistEnabled : false,
      },
      whitelist: custodial
        ? reg.whitelist
            .split(/[\s,]+/)
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
        : [],
      // Полное значение ключа не сохраняем — только то, что видно в кабинете.
      apiKeys: [{...apiKey, full: undefined}],
    });
    state.keystores[handle] = keystore;
    state.session = handle;

    syncRulesForm();
    persist();

    reg.created = {
      handle,
      account: address,
      accessKey: encodeAccessKey(secret),
      keystore,
      apiKey: apiKey.full,
    };
  } catch (cause) {
    reg.error = cause.message;
  } finally {
    reg.pending = false;
    render();
  }
}

async function submitLogin() {
  const login = state.login;
  login.pending = true;
  login.error = null;
  render();

  try {
    let secret;
    let handle;

    if (login.mode === "accessKey") {
      secret = decodeAccessKey(login.accessKey);
      const address = await addressFromSecret(secret);
      const found = allWallets().find((w) => w.account === address);
      if (!found) {
        throw new DemoError("Кошелёк с таким ключом в этом браузере не найден.");
      }
      handle = found.handle;
    } else {
      const keystore = state.keystores[login.handle];
      if (!keystore) {
        throw new DemoError("Выберите кошелёк.");
      }
      secret = await openKeystore(keystore, login.passphrase);

      // Расшифровали — проверяем, что ключ действительно от этого кошелька.
      const address = await addressFromSecret(secret);
      if (address !== keystore.address) {
        throw new DemoError("Ключ не соответствует кошельку.");
      }
      handle = keystore.handle;
    }

    state.session = handle;
    login.passphrase = "";
    login.accessKey = "";
    syncRulesForm();
    location.hash = "#/dashboard";
  } catch (cause) {
    login.error = cause.message;
  } finally {
    login.pending = false;
    render();
  }
}

/** Форма правил показывает то, что сейчас в кошельке. */
function syncRulesForm() {
  const w = wallet();
  if (!w) return;
  state.rules = {
    limitEth: w.rules.limitWei === 0n ? "" : formatEth(w.rules.limitWei),
    periodSeconds: Number(w.rules.periodSeconds),
    whitelistEnabled: w.rules.whitelistEnabled,
  };
}

// ---------------------------------------------------------------------
// Действия кабинета
// ---------------------------------------------------------------------

function doSendPayment() {
  const w = wallet();
  state.error = null;
  state.notice = null;

  try {
    const tx = sendPayment(w, state.form.to.trim(), parseEth(state.form.amountEth));
    state.form.to = "";
    state.form.amountEth = "";
    state.notice = `Транзакция ${tx.txHash.slice(0, 18)}…`;
  } catch (cause) {
    state.error = cause.message;
  }
  render();
}

function doSaveRules() {
  const w = wallet();
  state.error = null;
  state.notice = null;

  try {
    w.rules.limitWei = state.rules.limitEth.trim() ? parseEth(state.rules.limitEth) : 0n;
    w.rules.periodSeconds = BigInt(state.rules.periodSeconds);
    w.rules.whitelistEnabled = state.rules.whitelistEnabled;
    w.win = {startedAt: 0n, spent: 0n};
    persist();
    state.notice = "Изменения записаны в контракт.";
  } catch (cause) {
    state.error = cause.message;
  }
  render();
}

function doSetWhitelisted(allowed) {
  const w = wallet();
  state.error = null;
  state.notice = null;

  const target = state.form.target.trim().toLowerCase();
  if (!isAddress(target)) {
    state.error = "Поле «Адрес получателя» должно быть Ethereum-адресом.";
    return render();
  }

  w.whitelist = w.whitelist.filter((entry) => entry !== target);
  if (allowed) w.whitelist.push(target);

  state.form.target = "";
  state.notice = allowed ? "Адрес добавлен в whitelist." : "Адрес убран из whitelist.";
  persist();
  render();
}

function downloadKeystore() {
  const created = state.reg.created;
  if (!created) return;

  try {
    const blob = new Blob([JSON.stringify(created.keystore, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `synth-${created.handle}.keystore.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // Скачивание может быть запрещено окружением — содержимое всегда можно
    // раскрыть кнопкой рядом и скопировать вручную.
    state.revealedKey = "keystore";
    render();
  }
}

// ---------------------------------------------------------------------
// Отрисовка после действий
// ---------------------------------------------------------------------

/** Состояния контролов, зависящие от введённого текста, без перерисовки. */
function syncControls() {
  const reg = state.reg;
  const submit = document.querySelector('[data-act="register-submit"]');
  if (submit) {
    submit.disabled =
      reg.pending ||
      reg.handle.trim().length < 2 ||
      reg.passphrase.length < 8 ||
      reg.passphrase !== reg.passphrase2;
  }

  const loginSubmit = document.querySelector('[data-act="login-submit"]');
  if (loginSubmit) {
    loginSubmit.disabled =
      state.login.pending ||
      (state.login.mode === "accessKey"
        ? state.login.accessKey.trim().length < 10
        : !state.login.handle || state.login.passphrase.length === 0);
  }
}

document.addEventListener("input", (event) => {
  const path = event.target.dataset?.model;
  if (!path) return;

  const [group, key] = path.split(".");
  state[group][key] = event.target.value;

  // Поиск фильтрует список сразу; фокус вернёт restoreFocus.
  if (path === "adminForm.query") {
    render();
    return;
  }
  syncControls();
});

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-act]");
  if (!trigger) return;

  const act = trigger.dataset.act;
  const arg = trigger.dataset.arg;

  switch (act) {
    // --- регистрация ---
    case "mode-custodial":
      state.reg.mode = "HUMAN_CUSTODIAN";
      state.reg.error = null;
      return render();
    case "mode-autonomous":
      state.reg.mode = "AUTONOMOUS_ENTITY";
      state.reg.error = null;
      return render();
    case "reg-period":
      state.reg.periodSeconds = Number(arg);
      return render();
    case "reg-whitelist-toggle":
      state.reg.whitelistEnabled = !state.reg.whitelistEnabled;
      return render();
    case "register-submit":
      return submitRegistration();
    case "download-keystore":
      return downloadKeystore();
    case "toggle-keystore-json":
      state.revealedKey = state.revealedKey === "keystore" ? null : "keystore";
      return render();
    case "go-dashboard":
      state.reg.created = null;
      state.revealedKey = null;
      location.hash = "#/dashboard";
      return;

    // --- вход ---
    case "login-mode":
      state.login.mode = arg;
      state.login.error = null;
      return render();
    case "login-pick":
      state.login.handle = arg;
      state.login.error = null;
      return render();
    case "login-submit":
      return submitLogin();
    case "logout":
      state.session = null;
      state.notice = null;
      state.error = null;
      location.hash = "#/login";
      return;

    // --- кабинет ---
    case "send":
      return doSendPayment();
    case "fill-merchant":
      state.form.to = MERCHANT;
      return render();
    case "fill-target":
      state.form.target = MERCHANT;
      return render();
    case "rules-period":
      state.rules.periodSeconds = Number(arg);
      return render();
    case "rules-whitelist-toggle":
      state.rules.whitelistEnabled = !state.rules.whitelistEnabled;
      return render();
    case "save-rules":
      return doSaveRules();
    case "whitelist-allow":
      return doSetWhitelisted(true);
    case "whitelist-deny":
      return doSetWhitelisted(false);

    // --- API-ключи ---
    case "issue-key": {
      const key = issueApiKey();
      wallet().apiKeys.unshift({...key, full: undefined});
      state.revealedKey = key.full;
      state.error = null;
      state.notice = null;
      persist();
      return render();
    }
    case "revoke-key": {
      const key = wallet().apiKeys.find((entry) => entry.id === arg);
      if (key) key.revoked = true;
      state.revealedKey = null;
      state.notice = "Ключ отозван — запросы с ним больше не пройдут.";
      persist();
      return render();
    }

    // --- админка ---
    case "admin-login": {
      const {user, password} = state.adminForm;
      if (user.trim() !== ADMIN_USER || password !== ADMIN_PASSWORD) {
        state.adminForm.error = "Неверный логин или пароль.";
        return render();
      }
      state.admin = true;
      state.adminForm.error = null;
      state.adminForm.password = "";
      adminLog("Вход в панель оператора");
      return render();
    }
    case "admin-logout":
      state.admin = false;
      state.adminForm.user = "";
      state.adminForm.password = "";
      return render();
    case "admin-credit": {
      state.error = null;
      state.notice = null;
      try {
        const amount = parseEth(state.adminForm.amount);
        if (amount === 0n) throw new DemoError("Укажите сумму больше нуля.");
        creditWallet(arg, amount);
        adminLog(`Пополнение ${arg} на ${formatEth(amount)} ETH`);
        state.notice = `${arg}: зачислено ${formatEth(amount)} ETH`;
      } catch (cause) {
        state.error = cause.message;
      }
      return render();
    }
    case "admin-freeze": {
      const target = state.wallets[arg];
      if (!target) return;
      setFrozen(arg, !target.frozen);
      adminLog(`${target.frozen ? "Заморозка" : "Разморозка"} ${arg}`);
      state.error = null;
      state.notice = target.frozen
        ? `${arg}: траты остановлены`
        : `${arg}: траты снова разрешены`;
      return render();
    }
    case "admin-reset":
      resetDemoData();
      adminLog("Демо-данные сброшены");
      state.notice = "Демо-данные возвращены в исходное состояние.";
      return render();

    // --- общее ---
    case "copy": {
      navigator.clipboard?.writeText(arg);
      const original = trigger.innerHTML;
      trigger.innerHTML = `${icon("check", "size-3.5")}Скопировано`;
      setTimeout(() => {
        trigger.innerHTML = original;
      }, 1600);
      return;
    }
    case "toggle-live":
      state.live = !state.live;
      return render();
    default:
      return;
  }
});

window.addEventListener("hashchange", () => {
  state.notice = null;
  state.error = null;
  render();
  scrollAfterNavigation();
});

/**
 * Витрина должна выглядеть живой: раз в 14 секунд один из демо-агентов совершает
 * трату. Кошелёк владельца сессии эта имитация не трогает.
 */
setInterval(() => {
  if (!state.live) return;

  const pool = allWallets().filter((w) => w.demo && !w.frozen && w.handle !== state.session);
  if (pool.length === 0) return;

  const agent = pool[Math.floor(Math.random() * pool.length)];
  const value = parseEth((0.01 + Math.random() * 0.4).toFixed(3));
  if (value > agent.balanceWei) return;

  agent.balanceWei -= value;
  agent.txs.unshift({
    to: randomAddress(),
    valueWei: value,
    txHash: randomTxHash(),
    blockNumber: String(1000 + agent.txs.length * 3),
    timestamp: new Date(),
  });

  state.feed.unshift({
    handle: agent.handle,
    mode: agent.mode,
    to: shortAddress(randomAddress()),
    valueWei: value,
    txHash: randomTxHash(),
    timestamp: new Date(),
  });
  state.feed = state.feed.slice(0, 40);
  persist();

  if (["#/showcase", "#/"].includes(currentRoute())) render();
}, 14000);

// ---------------------------------------------------------------------
// Старт
// ---------------------------------------------------------------------

if (!restore()) {
  seedDemoData();
  persist();
}

render();
scrollAfterNavigation();
