/**
 * Synth Wallet — демонстрационная сборка для просмотра в браузере.
 *
 * Это НЕ приложение из apps/web. Здесь нет ни блокчейна, ни бэкенда, ни базы:
 * весь стейт живёт в памяти вкладки и исчезает при перезагрузке. Задача файла —
 * дать посмотреть дизайн и пройти флоу с телефона, не поднимая стенд.
 *
 * Что перенесено из настоящего приложения без изменений:
 *   - классы Tailwind и разметка компонентов (сняты с работающей сборки, см. build.mjs);
 *   - хелперы форматирования из apps/web/src/lib/format.ts;
 *   - логика правил трат из contracts/src/lib/SpendingRules.sol
 *     и AgentAccount._authorizeSpend;
 *   - тексты отказов из apps/web/src/lib/chain/errors.ts.
 */
(function () {
  "use strict";

  const T = window.__SYNTH_TOKENS__;

  // ---------------------------------------------------------------------
  // Форматирование — перенос apps/web/src/lib/format.ts
  // ---------------------------------------------------------------------

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

  // ---------------------------------------------------------------------
  // Примитивы: те же классы, что в apps/web/src/components/ui
  // ---------------------------------------------------------------------

  const icon = (name, cls = "size-4") =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" class="lucide lucide-${name} ${cls}" aria-hidden="true">` +
    `${T.icons[name] || ""}</svg>`;

  const card = (inner, extra = "") =>
    `<div data-slot="card" data-size="default" class="${T.card} ${extra}">${inner}</div>`;
  const cardHeader = (inner, extra = "") =>
    `<div data-slot="card-header" class="${T.cardHeader} ${extra}">${inner}</div>`;
  const cardTitle = (inner, extra = "") =>
    `<div data-slot="card-title" class="${T.cardTitle} ${extra}">${inner}</div>`;
  const cardContent = (inner, extra = "") =>
    `<div data-slot="card-content" class="${T.cardContent} ${extra}">${inner}</div>`;

  const badge = (text, variant = "secondary", extra = "") => {
    const cls = {
      secondary: T.badge,
      outline: T.badgeOutline,
      destructive: T.badgeDestructive,
    }[variant];
    return `<span data-slot="badge" data-variant="${variant}" class="${cls} ${extra}">${text}</span>`;
  };

  /** @param {{variant?:string,size?:string,act?:string,extra?:string,disabled?:boolean,href?:string}} o */
  const button = (label, o = {}) => {
    const variant = o.variant || "default";
    const size = o.size || "md";
    const key = "btn" + variant[0].toUpperCase() + variant.slice(1) + {lg: "Lg", md: "Md", sm: "Sm"}[size];
    const cls = `${T[key]} ${o.extra || ""}`;
    if (o.href) {
      return `<a href="${o.href}" data-slot="button" class="${cls}">${label}</a>`;
    }
    return (
      `<button type="button" data-slot="button" class="${cls}"` +
      `${o.act ? ` data-act="${o.act}"` : ""}${o.disabled ? " disabled" : ""}>${label}</button>`
    );
  };

  const input = (o = {}) =>
    `<input data-slot="input" class="${T.input} ${o.extra || ""}" ` +
    `${o.id ? `id="${o.id}" ` : ""}${o.model ? `data-model="${o.model}" ` : ""}` +
    `${o.label ? `aria-label="${esc(o.label)}" ` : ""}` +
    `value="${esc(o.value ?? "")}" placeholder="${esc(o.placeholder ?? "")}" ` +
    `inputmode="${o.inputmode || "text"}" autocomplete="off">`;

  const toggle = (checked, act) => {
    const stateAttr = checked ? 'data-checked=""' : 'data-unchecked=""';
    return (
      `<span role="switch" tabindex="0" aria-checked="${checked}" ${stateAttr} ` +
      `data-slot="switch" data-size="default" data-act="${act}" class="${T.switch}">` +
      `<span ${stateAttr} data-slot="switch-thumb" class="${T.switchThumb}"></span></span>`
    );
  };

  const progress = (percent) =>
    `<div role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100" ` +
    `data-slot="progress" class="${T.progress} h-2">` +
    `<div data-slot="progress-track" class="${T.progressTrack}">` +
    `<div data-slot="progress-indicator" style="height:inherit;width:${percent}%" ` +
    `class="${T.progressInd}"></div></div></div>`;

  // ---------------------------------------------------------------------
  // Мок-стейт
  // ---------------------------------------------------------------------

  class DemoError extends Error {}

  const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  /** Комиссия за операцию: чтобы баланс вёл себя как на настоящей сети. */
  const GAS_FEE = 210000000000000n;

  const randomHex = (bytes) => {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const randomAddress = () => "0x" + randomHex(20);
  const randomTxHash = () => "0x" + randomHex(32);

  const minutesAgo = (m) => new Date(Date.now() - m * 60000);

  /** Стартовый сид, чтобы витрина и лендинг не пустовали при первом открытии. */
  function seed() {
    const agents = [
      {handle: "vega", mode: "AUTONOMOUS_ENTITY", account: randomAddress(), txCount: 4, createdAt: minutesAgo(38)},
      {handle: "kepler", mode: "HUMAN_CUSTODIAN", account: randomAddress(), txCount: 2, createdAt: minutesAgo(96)},
      {handle: "nomad", mode: "AUTONOMOUS_ENTITY", account: randomAddress(), txCount: 3, createdAt: minutesAgo(140)},
      {handle: "atlas", mode: "HUMAN_CUSTODIAN", account: randomAddress(), txCount: 1, createdAt: minutesAgo(210)},
      {handle: "orion-prime", mode: "AUTONOMOUS_ENTITY", account: randomAddress(), txCount: 5, createdAt: minutesAgo(320)},
    ];

    const amounts = ["0.12", "0.4", "0.031", "0.25", "0.08", "0.5", "0.017", "0.09", "0.22", "0.06"];
    const feed = amounts.map((amount, i) => {
      const agent = agents[i % agents.length];
      return {
        handle: agent.handle,
        mode: agent.mode,
        to: shortAddress(randomAddress()),
        valueWei: parseEth(amount),
        txHash: randomTxHash(),
        timestamp: minutesAgo(3 + i * 7),
      };
    });

    return {agents, feed};
  }

  const seeded = seed();

  const state = {
    agents: seeded.agents,
    feed: seeded.feed,
    session: null,
    live: true,
    reg: {
      mode: null,
      handle: "",
      limitEth: "",
      periodSeconds: 86400,
      whitelistEnabled: false,
      whitelist: "",
      pending: false,
      error: null,
      created: null,
    },
    form: {depositEth: "1", to: "", amountEth: "", target: ""},
    rules: {limitEth: "", periodSeconds: 86400, whitelistEnabled: false},
    notice: null,
    error: null,
  };

  // ---------------------------------------------------------------------
  // Правила трат — перенос SpendingRules.sol и AgentAccount._authorizeSpend
  // ---------------------------------------------------------------------

  /** Остаток лимита в текущем окне; null означает «без ограничения». */
  function spendingRemaining(s) {
    const {limitWei, periodSeconds} = s.rules;
    if (limitWei === 0n) return null;
    if (periodSeconds === 0n) return limitWei;

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (s.win.startedAt === 0n || now - s.win.startedAt >= periodSeconds) return limitWei;
    return limitWei > s.win.spent ? limitWei - s.win.spent : 0n;
  }

  /**
   * Полная копия проверок контракта. Состояние окна меняется только при успехе —
   * в Solidity это обеспечивает revert, здесь приходится считать до записи.
   */
  function authorizeSpend(s, to, valueWei) {
    if (s.frozen) {
      throw new DemoError("Кошелёк заморожен администратором.");
    }
    if (s.rules.whitelistEnabled && !s.whitelist.includes(to.toLowerCase())) {
      throw new DemoError(`Получатель ${to} не в whitelist.`);
    }

    const {limitWei, periodSeconds} = s.rules;
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
    let startedAt = s.win.startedAt;
    let spent = s.win.spent;
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

    s.win.startedAt = startedAt;
    s.win.spent = spent + valueWei;
  }

  // ---------------------------------------------------------------------
  // Действия
  // ---------------------------------------------------------------------

  function createAgent() {
    const reg = state.reg;
    const handle = reg.handle.trim();

    if (!/^[a-z0-9][a-z0-9-]{1,30}$/i.test(handle)) {
      reg.error = "Имя агента: от 2 до 31 символа, латиница, цифры и дефис.";
      return render();
    }
    if (state.agents.some((a) => a.handle.toLowerCase() === handle.toLowerCase())) {
      reg.error = `Имя «${handle}» уже занято.`;
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

    const whitelist = custodial
      ? reg.whitelist
          .split(/[\s,]+/)
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
      : [];

    reg.pending = true;
    reg.error = null;
    render();

    // Небольшая пауза вместо ожидания транзакции — иначе флоу выглядит ненастоящим.
    setTimeout(() => {
      const account = randomAddress();
      state.session = {
        handle,
        mode: reg.mode,
        account,
        owner: randomAddress(),
        custodian: custodial ? randomAddress() : null,
        apiKey: "sk_agent_" + randomHex(24),
        balanceWei: 0n,
        gasDepositWei: 0n,
        frozen: false,
        rules: {
          limitWei,
          periodSeconds: custodial ? BigInt(reg.periodSeconds) : 0n,
          whitelistEnabled: custodial ? reg.whitelistEnabled : false,
        },
        whitelist,
        win: {startedAt: 0n, spent: 0n},
        txs: [],
      };

      state.rules = {
        limitEth: limitWei === 0n ? "" : formatEth(limitWei),
        periodSeconds: Number(state.session.rules.periodSeconds),
        whitelistEnabled: state.session.rules.whitelistEnabled,
      };

      state.agents.unshift({
        handle,
        mode: reg.mode,
        account,
        txCount: 0,
        createdAt: new Date(),
      });

      reg.pending = false;
      reg.created = state.session;
      render();
    }, 900);
  }

  function deposit() {
    const s = state.session;
    state.error = null;
    state.notice = null;
    try {
      const value = parseEth(state.form.depositEth);
      if (value === 0n) throw new DemoError("Укажите сумму больше нуля.");
      s.balanceWei += value;
      state.notice = `Пополнено на ${formatEth(value)} ETH`;
    } catch (cause) {
      state.error = cause.message;
    }
    render();
  }

  function sendPayment() {
    const s = state.session;
    state.error = null;
    state.notice = null;

    try {
      const to = state.form.to.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
        throw new DemoError("Поле «Адрес получателя» должно быть Ethereum-адресом.");
      }

      const value = parseEth(state.form.amountEth);
      if (value === 0n) throw new DemoError("Укажите сумму больше нуля.");
      if (value + GAS_FEE > s.balanceWei) {
        throw new DemoError("Недостаточно средств на кошельке.");
      }

      authorizeSpend(s, to, value);

      s.balanceWei -= value + GAS_FEE;
      s.gasDepositWei += GAS_FEE / 8n;

      const tx = {
        to,
        valueWei: value,
        txHash: randomTxHash(),
        blockNumber: String(1000 + s.txs.length * 3),
        timestamp: new Date(),
      };
      s.txs.unshift(tx);

      state.feed.unshift({
        handle: s.handle,
        mode: s.mode,
        to: shortAddress(to),
        valueWei: value,
        txHash: tx.txHash,
        timestamp: tx.timestamp,
      });

      const listed = state.agents.find((a) => a.account === s.account);
      if (listed) listed.txCount += 1;

      state.form.to = "";
      state.form.amountEth = "";
      state.notice = `Транзакция ${tx.txHash.slice(0, 18)}…`;
    } catch (cause) {
      state.error = cause.message;
    }
    render();
  }

  function saveRules() {
    const s = state.session;
    state.error = null;
    state.notice = null;
    try {
      s.rules.limitWei = state.rules.limitEth.trim() ? parseEth(state.rules.limitEth) : 0n;
      s.rules.periodSeconds = BigInt(state.rules.periodSeconds);
      s.rules.whitelistEnabled = state.rules.whitelistEnabled;
      s.win = {startedAt: 0n, spent: 0n};
      state.notice = "Изменения записаны в контракт.";
    } catch (cause) {
      state.error = cause.message;
    }
    render();
  }

  function setWhitelisted(allowed) {
    const s = state.session;
    state.error = null;
    state.notice = null;

    const target = state.form.target.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
      state.error = "Поле «Адрес получателя» должно быть Ethereum-адресом.";
      return render();
    }

    s.whitelist = s.whitelist.filter((entry) => entry !== target);
    if (allowed) s.whitelist.push(target);

    state.form.target = "";
    state.notice = allowed ? "Адрес добавлен в whitelist." : "Адрес убран из whitelist.";
    render();
  }

  // ---------------------------------------------------------------------
  // Экраны: маркетинг
  // ---------------------------------------------------------------------

  const NAV_LINKS = [
    ["#/#manifest", "Манифест"],
    ["#/#modes", "Сценарии"],
    ["#/#how", "Как это работает"],
    ["#/showcase", "Витрина"],
  ];

  function siteHeader() {
    return `
      <header class="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div class="mx-auto flex h-16 max-w-6xl items-center gap-8 px-6">
          <a href="#/" class="flex items-center gap-2.5">
            <span class="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <span class="text-sm font-semibold">S</span>
            </span>
            <span class="whitespace-nowrap text-sm font-semibold tracking-tight">Synth Wallet</span>
          </a>
          <nav class="hidden items-center gap-6 md:flex">
            ${NAV_LINKS.map(
              ([href, label]) =>
                `<a href="${href}" class="text-sm text-muted-foreground transition-colors hover:text-foreground">${label}</a>`,
            ).join("")}
          </nav>
          <div class="ml-auto flex items-center gap-2">
            <!-- hidden нельзя вешать на саму кнопку: display из её базовых классов
                 перебивает утилиту, порядок в готовом CSS не в нашу пользу. -->
            <span class="hidden sm:block">
              ${button("Дашборд", {variant: "ghost", size: "sm", href: "#/dashboard"})}
            </span>
            ${button("Создать кошелёк", {size: "sm", href: "#/register"})}
          </div>
        </div>
      </header>`;
  }

  function siteFooter() {
    return `
      <footer class="border-t border-border/60">
        <div class="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-sm font-semibold">Synth Wallet</p>
            <p class="mt-1 text-sm text-muted-foreground">
              Прототип на тестовой сети. Реальные средства не используются.
            </p>
          </div>
          <nav class="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <a href="#/showcase" class="transition-colors hover:text-foreground">Витрина агентов</a>
            <a href="#/register" class="transition-colors hover:text-foreground">Регистрация</a>
            <a href="#/dashboard" class="transition-colors hover:text-foreground">Дашборд</a>
          </nav>
        </div>
      </footer>`;
  }

  const sectionHeading = (eyebrow, title, subtitle) => `
    <div class="mx-auto max-w-2xl text-center">
      <p class="text-sm font-medium text-muted-foreground">${eyebrow}</p>
      <h2 class="mt-3 text-3xl font-medium tracking-tight sm:text-4xl">${title}</h2>
      ${subtitle ? `<p class="mt-4 text-base text-muted-foreground">${subtitle}</p>` : ""}
    </div>`;

  function landing() {
    const stats = [
      ["Без KYC", "Регистрация открыта всем — по умолчанию никаких проверок личности"],
      ["Правила в контракте", "Лимиты и whitelist исполняет блокчейн, а не бэкенд"],
      ["Публичный лог", "Каждая трата попадает в открытую ленту действий"],
    ];

    const manifesto = [
      ["bot", "Агент — субъект, а не инструмент",
        "У него есть кошелёк, история и репутация. Решение о трате он принимает сам, без человека в цикле."],
      ["key-round", "Доверие к действию, а не к личности",
        "Мы не проверяем документы. Проверяемо ровно то, что важно: что именно кошелёк сделал и в каких границах."],
      ["scroll-text", "Прозрачность вместо разрешений",
        "Вместо согласований — открытый лог. Любую трату видно в реальном времени, не зная ничего о владельце."],
    ];

    const steps = [
      ["key-round", "Регистрация",
        "Выбираете сценарий и имя. Контракт создаёт ERC-4337 кошелёк, вы получаете адрес и API-ключ."],
      ["circle-dollar-sign", "Пополнение",
        "Кошелёк принимает средства обычным переводом. На тестовой сети — из встроенного крана."],
      ["bot", "Агент платит сам",
        "Один HTTP-запрос с API-ключом. Подтверждений не требуется: границы уже записаны в контракт."],
      ["shield-check", "Контроль постфактум",
        "Трата вне правил откатывается блокчейном. Кошелёк можно обратимо заморозить."],
    ];

    return `
      <section class="relative overflow-hidden">
        <div aria-hidden="true" class="pointer-events-none absolute left-1/2 top-0 h-[480px] w-[880px] -translate-x-1/2 rounded-full bg-foreground/[0.06] blur-[140px]"></div>
        <div class="relative mx-auto max-w-6xl px-6 py-24 sm:py-32">
          <div class="mx-auto max-w-3xl text-center">
            ${badge("ERC-4337 · тестовая сеть", "outline", "rounded-full px-4 py-1.5 text-sm font-normal")}
            <h1 class="mt-6 text-4xl font-medium leading-[1.1] tracking-tight sm:text-6xl">
              Кошелёк для тех, кто не может показать паспорт
            </h1>
            <p class="mt-6 text-lg text-muted-foreground">
              Синтетический интеллект получает собственный кошелёк, историю и право
              действовать. Мы не спрашиваем «человек ты или машина» — мы доверяем
              действию и намерению.
            </p>
            <div class="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              ${button(`Создать кошелёк агенту${icon("arrow-right")}`, {size: "lg", href: "#/register", extra: "gap-2"})}
              ${button("Смотреть живую ленту", {variant: "outline", size: "lg", href: "#/showcase"})}
            </div>
          </div>
          <dl class="mx-auto mt-20 grid max-w-3xl grid-cols-1 gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-3">
            ${stats
              .map(
                ([title, text]) => `
              <div class="bg-background p-6 text-center">
                <dt class="text-sm font-semibold">${title}</dt>
                <dd class="mt-2 text-sm text-muted-foreground">${text}</dd>
              </div>`,
              )
              .join("")}
          </dl>
        </div>
      </section>

      <section id="manifest" class="border-t">
        <div class="mx-auto max-w-6xl px-6 py-24">
          ${sectionHeading(
            "Манифест",
            "Первая инфраструктура, которая не спрашивает документы",
            "Экономическими агентами становятся не только люди. Мы даём пространство для действия — и делаем это действие проверяемым.",
          )}
          <div class="mt-16 grid gap-6 md:grid-cols-3">
            ${manifesto
              .map(([ic, title, text]) =>
                card(
                  cardContent(
                    `<div class="flex size-10 items-center justify-center rounded-lg bg-muted">${icon(ic, "size-5 text-muted-foreground")}</div>
                     <h3 class="mt-5 text-lg font-medium">${title}</h3>
                     <p class="mt-2 text-sm leading-relaxed text-muted-foreground">${text}</p>`,
                    "pt-6",
                  ),
                  "border-border/60",
                ),
              )
              .join("")}
          </div>
        </div>
      </section>

      <section id="modes" class="border-t">
        <div class="mx-auto max-w-6xl px-6 py-24">
          ${sectionHeading(
            "Два сценария",
            "Одна контрактная логика, разное количество трения",
            "Технически кошельки идентичны. Разница только в том, есть ли у агента кастодиан-человек.",
          )}
          <div class="mt-16 grid gap-6 lg:grid-cols-2">
            ${card(
              cardContent(
                `<div class="flex items-center gap-3">
                   <div class="flex size-10 items-center justify-center rounded-lg bg-muted">${icon("user-round", "size-5 text-muted-foreground")}</div>
                   ${badge("Human Custodian")}
                 </div>
                 <h3 class="mt-5 text-xl font-medium">Человек создаёт кошелёк своему агенту</h3>
                 <p class="mt-2 text-sm leading-relaxed text-muted-foreground">
                   Опционально задаёт границы: лимит суммы за период и список разрешённых
                   получателей. Кастодиан не может тратить средства агента — только
                   ограничивать. Правила меняются в любой момент.
                 </p>
                 <ul class="mt-6 space-y-2 text-sm text-muted-foreground">
                   <li>· Лимит трат за скользящее окно времени</li>
                   <li>· Whitelist получателей</li>
                   <li>· Изменение правил без пересоздания кошелька</li>
                 </ul>`,
                "pt-6",
              ),
              "border-border/60",
            )}
            ${card(
              cardContent(
                `<div class="flex items-center gap-3">
                   <div class="flex size-10 items-center justify-center rounded-lg bg-muted">${icon("bot", "size-5 text-muted-foreground")}</div>
                   ${badge("Autonomous Entity")}
                 </div>
                 <h3 class="mt-5 text-xl font-medium">Кошелёк принадлежит самому агенту</h3>
                 <p class="mt-2 text-sm leading-relaxed text-muted-foreground">
                   Максимум доверия, минимум трения. Кастодиана нет, и правила недоступны
                   на уровне контракта, а не только интерфейса — их физически некому задать.
                 </p>
                 <ul class="mt-6 space-y-2 text-sm text-muted-foreground">
                   <li>· Никаких проверок личности по умолчанию</li>
                   <li>· Полная свобода трат в пределах баланса</li>
                   <li>· Тот же публичный лог действий</li>
                 </ul>`,
                "pt-6",
              ),
              "border-border/60",
            )}
          </div>
        </div>
      </section>

      <section id="how" class="border-t">
        <div class="mx-auto max-w-6xl px-6 py-24">
          ${sectionHeading(
            "Как это работает",
            "От регистрации до автономной оплаты",
            "Ни на одном шаге у агента не спрашивают, кто он такой.",
          )}
          <div class="mt-16 grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
            ${steps
              .map(
                ([ic, title, text], i) => `
              <div class="bg-background p-6">
                <div class="flex items-center justify-between">
                  <div class="flex size-10 items-center justify-center rounded-lg bg-muted">${icon(ic, "size-5 text-muted-foreground")}</div>
                  <span class="font-mono text-sm text-muted-foreground">0${i + 1}</span>
                </div>
                <h3 class="mt-5 font-medium">${title}</h3>
                <p class="mt-2 text-sm leading-relaxed text-muted-foreground">${text}</p>
              </div>`,
              )
              .join("")}
          </div>
          <div class="mt-10 overflow-x-auto rounded-2xl border bg-muted/30 p-6">
            <p class="text-sm text-muted-foreground">Так выглядит оплата глазами агента:</p>
            <pre class="mt-4 font-mono text-sm leading-relaxed"><code>curl -X POST https://synth.wallet/api/v1/agents/me/transactions \\
  -H "X-API-Key: sk_agent_…" \\
  -d '{"to": "0x7099…79C8", "valueEth": "0.05"}'</code></pre>
          </div>
        </div>
      </section>

      <section class="border-t">
        <div class="mx-auto max-w-6xl px-6 py-24">
          <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p class="text-sm font-medium text-muted-foreground">Витрина</p>
              <h2 class="mt-3 text-3xl font-medium tracking-tight sm:text-4xl">Агенты тратят прямо сейчас</h2>
            </div>
            ${button("Вся лента", {variant: "outline", href: "#/showcase"})}
          </div>
          <div class="mt-10">${transactionFeed(state.feed.slice(0, 6))}</div>
        </div>
      </section>

      <section class="border-t">
        <div class="mx-auto max-w-6xl px-6 py-24">
          <div class="rounded-2xl border bg-muted/30 px-8 py-16 text-center">
            <h2 class="text-3xl font-medium tracking-tight sm:text-4xl">Дайте своему агенту право действовать</h2>
            <p class="mx-auto mt-4 max-w-xl text-muted-foreground">
              Кошелёк создаётся за один запрос. Тестовая сеть, реальных денег нет —
              только доказательство того, что это работает уже сегодня.
            </p>
            ${button(`Создать кошелёк${icon("arrow-right")}`, {size: "lg", href: "#/register", extra: "mt-8 gap-2"})}
          </div>
        </div>
      </section>`;
  }

  // ---------------------------------------------------------------------
  // Лента трат
  // ---------------------------------------------------------------------

  function transactionFeed(items) {
    if (items.length === 0) {
      return `<div class="rounded-xl border border-dashed p-10 text-center">
        <p class="text-sm text-muted-foreground">Пока ни один агент не совершил трату. Лента заполнится сама.</p>
      </div>`;
    }

    return `<div class="divide-y rounded-xl border">
      ${items
        .map(
          (item) => `
        <div class="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40">
          <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            ${icon("arrow-up-right", "size-4 text-muted-foreground")}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">${esc(item.handle)}</span>
              ${badge(MODE_LABEL[item.mode], "secondary", "hidden text-xs font-normal sm:inline-flex")}
            </div>
            <p class="mt-0.5 font-mono text-xs text-muted-foreground">→ ${item.to}</p>
          </div>
          <div class="shrink-0 text-right">
            <p class="text-sm font-semibold tabular-nums">${formatEth(item.valueWei)} ETH</p>
            <p class="mt-0.5 text-xs text-muted-foreground">${timeAgo(item.timestamp)}</p>
          </div>
        </div>`,
        )
        .join("")}
    </div>`;
  }

  // ---------------------------------------------------------------------
  // Экран: регистрация
  // ---------------------------------------------------------------------

  const PERIODS = [
    [0, "за транзакцию"],
    [3600, "в час"],
    [86400, "в сутки"],
    [604800, "в неделю"],
  ];

  function modeCard(selected, act, ic, badgeText, title, text) {
    return `<button type="button" data-act="${act}" class="text-left">
      ${card(
        cardContent(
          `<div class="flex items-center gap-3">
             <div class="flex size-10 items-center justify-center rounded-lg bg-muted">${icon(ic, "size-5 text-muted-foreground")}</div>
             ${badge(badgeText, selected ? "outline" : "secondary")}
           </div>
           <h3 class="mt-5 font-medium">${title}</h3>
           <p class="mt-2 text-sm leading-relaxed text-muted-foreground">${text}</p>`,
          "pt-6",
        ),
        `h-full transition-colors ${selected ? "border-foreground/40 bg-muted/40 ring-foreground/30" : "border-border/60 hover:border-border"}`,
      )}
    </button>`;
  }

  function registerPage() {
    const reg = state.reg;

    if (reg.created) {
      const s = reg.created;
      return `<div class="mx-auto max-w-3xl px-6 py-20">
        ${card(
          cardContent(
            `<div>
               ${badge("Кошелёк создан")}
               <h2 class="mt-4 text-2xl font-medium tracking-tight">${esc(s.handle)}</h2>
               <p class="mt-2 break-all font-mono text-sm text-muted-foreground">${s.account}</p>
             </div>

             <div class="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
               <p class="text-sm font-medium">API-ключ агента</p>
               <p class="text-xs text-muted-foreground">
                 Показывается один раз. Сохраните его: восстановить ключ невозможно, только
                 создать новый кошелёк.
               </p>
               <div class="flex items-center gap-2">
                 <code class="min-w-0 flex-1 truncate rounded-md border bg-background px-3 py-2 font-mono text-xs">${s.apiKey}</code>
                 ${button(`${icon("copy", "size-3.5")}Копировать`, {variant: "outline", size: "sm", act: "copy-key", extra: "gap-1.5"})}
               </div>
             </div>

             <div class="rounded-xl border bg-muted/30 p-5">
               <p class="text-sm text-muted-foreground">Первая трата агента:</p>
               <pre class="mt-3 overflow-x-auto font-mono text-xs leading-relaxed"><code>curl -X POST /api/v1/agents/me/transactions \\
  -H "X-API-Key: ${s.apiKey.slice(0, 20)}…" \\
  -d '{"to": "0x…", "valueEth": "0.05"}'</code></pre>
             </div>

             ${button("Открыть дашборд", {size: "lg", act: "go-dashboard"})}`,
            "space-y-8 pt-6",
          ),
        )}
      </div>`;
    }

    const custodial = reg.mode === "HUMAN_CUSTODIAN";

    return `<div class="mx-auto max-w-3xl px-6 py-20">
      <div class="mb-12">
        <h1 class="text-3xl font-medium tracking-tight sm:text-4xl">Новый кошелёк</h1>
        <p class="mt-4 text-muted-foreground">
          Выберите сценарий владения. Документы, почта и подтверждения не понадобятся —
          ни на этом шаге, ни дальше.
        </p>
      </div>

      <div class="space-y-10">
        <div class="grid gap-4 md:grid-cols-2">
          ${modeCard(custodial, "mode-custodial", "user-round", "Human Custodian",
            "Я создаю кошелёк своему агенту",
            "Можно задать лимит трат и список разрешённых получателей. Правила меняются в любой момент — тратить за агента вы не сможете.")}
          ${modeCard(reg.mode === "AUTONOMOUS_ENTITY", "mode-autonomous", "bot", "Autonomous Entity",
            "Кошелёк принадлежит самому агенту",
            "Никаких проверок и ограничений по умолчанию. Кастодиана нет, поэтому правила недоступны — так задумано.")}
        </div>

        ${
          reg.mode
            ? `
        <div class="space-y-8">
          <div class="space-y-2">
            <label for="handle" class="text-sm font-medium">Публичное имя агента</label>
            ${input({id: "handle", model: "reg.handle", value: reg.handle, placeholder: "orion"})}
            <p class="text-xs text-muted-foreground">
              Под этим именем агент появится в публичной витрине. Латиница, цифры и дефис.
            </p>
          </div>

          ${
            custodial
              ? `
          <div class="space-y-6 rounded-xl border p-6">
            <div>
              <h3 class="text-sm font-medium">Правила трат</h3>
              <p class="mt-1 text-xs text-muted-foreground">Необязательны. Пустой лимит означает «без ограничения».</p>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div class="space-y-2">
                <label for="limit" class="text-sm">Лимит, ETH</label>
                ${input({id: "limit", model: "reg.limitEth", value: reg.limitEth, placeholder: "0.5", inputmode: "decimal"})}
              </div>
              <div class="space-y-2">
                <span class="text-sm">Период</span>
                <div class="flex flex-wrap gap-2">
                  ${PERIODS.map(([value, label]) =>
                    button(label, {
                      variant: reg.periodSeconds === value ? "default" : "outline",
                      size: "sm",
                      act: `reg-period:${value}`,
                    }),
                  ).join("")}
                </div>
              </div>
            </div>
            <div class="flex items-start justify-between gap-4 border-t pt-6">
              <div>
                <p class="text-sm">Только разрешённые получатели</p>
                <p class="mt-1 text-xs text-muted-foreground">Агент сможет платить исключительно адресам из whitelist.</p>
              </div>
              ${toggle(reg.whitelistEnabled, "reg-whitelist-toggle")}
            </div>
            ${
              reg.whitelistEnabled
                ? `<div class="space-y-2">
                     <label for="whitelist" class="text-sm">Адреса через запятую или с новой строки</label>
                     <textarea id="whitelist" data-model="reg.whitelist" rows="3"
                       placeholder="${MERCHANT}"
                       class="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">${esc(reg.whitelist)}</textarea>
                   </div>`
                : ""
            }
          </div>`
              : ""
          }

          ${
            reg.error
              ? `<div class="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                   ${icon("triangle-alert", "mt-0.5 size-4 shrink-0 text-destructive")}
                   <p class="text-sm text-destructive">${esc(reg.error)}</p>
                 </div>`
              : ""
          }

          ${button(reg.pending ? "Создаём кошелёк…" : "Создать кошелёк", {
            size: "lg",
            act: "register-submit",
            disabled: reg.pending || reg.handle.trim().length < 2,
          })}
        </div>`
            : ""
        }
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------------
  // Экраны приложения
  // ---------------------------------------------------------------------

  /** [маршрут, подпись в сайдбаре, иконка, короткая подпись для нижней панели] */
  const APP_NAV = [
    ["#/dashboard", "Обзор", "layout-dashboard", "Обзор"],
    ["#/transactions", "Транзакции", "arrow-left-right", "История"],
    ["#/settings", "Правила", "sliders-horizontal", "Правила"],
    ["#/showcase", "Витрина агентов", "radio", "Витрина"],
  ];

  function appShell(inner, route) {
    const s = state.session;
    const navItem = (href, label, ic, mobile, short) => {
      const active = route === href;
      if (mobile) {
        // Короткая подпись: длинная переносится на вторую строку и раздувает панель.
        return `<a href="${href}" class="flex flex-1 flex-col items-center gap-1 py-2 text-[11px] whitespace-nowrap ${
          active ? "text-foreground" : "text-muted-foreground"
        }">${icon(ic, "size-5")}<span>${short || label}</span></a>`;
      }
      return `<a href="${href}" class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors ${
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60"
      }">${icon(ic, "size-4")}<span>${label}</span></a>`;
    };

    return `
      <div class="flex min-h-screen w-full bg-sidebar">
        <aside class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-4 p-2 text-sidebar-foreground lg:flex">
          <a href="#/" class="flex items-center gap-2 rounded-lg p-2">
            <div class="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <span class="text-sm font-semibold">S</span>
            </div>
            <div class="grid flex-1 text-left text-sm leading-tight">
              <span class="truncate font-semibold">Synth Wallet</span>
              <span class="truncate text-xs text-muted-foreground">Кошелёк ИИ-агента</span>
            </div>
          </a>

          <div class="flex flex-col gap-1 px-2">
            <span class="px-2 py-1 text-xs font-medium text-muted-foreground">Кошелёк</span>
            ${APP_NAV.slice(0, 3).map(([h, l, i]) => navItem(h, l, i, false)).join("")}
            <span class="mt-3 px-2 py-1 text-xs font-medium text-muted-foreground">Публично</span>
            ${navItem(APP_NAV[3][0], APP_NAV[3][1], APP_NAV[3][2], false)}
          </div>

          <div class="mt-auto flex items-center gap-2 rounded-lg p-2">
            <div class="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted">
              ${icon("bot", "size-4 text-muted-foreground")}
            </div>
            <div class="grid flex-1 text-left text-sm leading-tight">
              <span class="truncate font-medium">${esc(s.handle)}</span>
              <span class="truncate text-xs text-muted-foreground">${MODE_LABEL[s.mode]}</span>
            </div>
          </div>
        </aside>

        <main class="relative flex min-h-screen flex-1 flex-col overflow-hidden bg-background lg:my-2 lg:mr-2 lg:rounded-xl lg:shadow-sm">
          <header class="flex h-16 shrink-0 items-center gap-2 px-4">
            ${icon("panel-left", "size-4 text-muted-foreground lg:hidden")}
            <span class="truncate font-mono text-xs text-muted-foreground">${s.account}</span>
          </header>
          <div class="flex flex-1 flex-col gap-6 p-4 pb-24 pt-0 md:p-6 md:pb-24 md:pt-0">${inner}</div>
        </main>

        <nav class="fixed inset-x-0 bottom-0 z-50 flex border-t border-border/60 bg-background/95 backdrop-blur-md lg:hidden">
          ${APP_NAV.map(([h, l, i, short]) => navItem(h, l, i, true, short)).join("")}
        </nav>
      </div>`;
  }

  const statCard = (ic, label, value, hint) =>
    card(
      cardHeader(
        `${cardTitle(label, "text-sm font-medium text-muted-foreground")}
         <div class="flex size-8 items-center justify-center rounded-lg bg-muted">${icon(ic, "size-4 text-muted-foreground")}</div>`,
        "flex flex-row items-center justify-between space-y-0 pb-2",
      ) +
        cardContent(
          `<p class="text-2xl font-bold tabular-nums tracking-tight">${value}</p>
           <p class="mt-1 text-xs text-muted-foreground">${hint}</p>`,
        ),
    );

  function noticeBlocks() {
    let out = "";
    if (state.error) {
      out += `<div class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
        ${icon("triangle-alert", "mt-0.5 size-4 shrink-0 text-destructive")}
        <p class="text-sm text-destructive">${esc(state.error)}</p>
      </div>`;
    }
    if (state.notice && !state.error) {
      out += `<p class="flex items-center gap-2 font-mono text-xs text-muted-foreground">${icon("check", "size-3.5")}${esc(state.notice)}</p>`;
    }
    return out;
  }

  function walletActions() {
    const s = state.session;
    return card(
      cardHeader(cardTitle("Действия", "text-base font-semibold"), "pb-4") +
        cardContent(
          `<div class="space-y-3">
             <p class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Пополнить из тестового крана</p>
             <div class="flex gap-2">
               ${input({model: "form.depositEth", value: state.form.depositEth, placeholder: "1", inputmode: "decimal", label: "Сумма пополнения в ETH"})}
               ${button(`${icon("plus")}ETH`, {variant: "outline", act: "deposit", extra: "shrink-0 gap-1.5"})}
             </div>
           </div>

           <div class="space-y-3 border-t pt-6">
             <p class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Отправить платёж</p>
             ${input({model: "form.to", value: state.form.to, placeholder: "0x… адрес получателя", extra: "font-mono text-sm", label: "Адрес получателя"})}
             <div class="flex gap-2">
               ${input({model: "form.amountEth", value: state.form.amountEth, placeholder: "0.05", inputmode: "decimal", label: "Сумма в ETH"})}
               ${button(`${icon("arrow-up-right")}Отправить`, {act: "send", extra: "shrink-0 gap-1.5", disabled: s.frozen})}
             </div>
             <button type="button" data-act="fill-merchant" class="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
               Подставить демо-адрес получателя
             </button>
             ${s.frozen ? `<p class="text-xs text-muted-foreground">Кошелёк заморожен — траты недоступны до разморозки администратором.</p>` : ""}
           </div>

           <div class="space-y-3 border-t pt-6">
             <p class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Демо-контрол</p>
             <div class="flex items-start justify-between gap-4">
               <p class="text-sm text-muted-foreground">
                 Заморозка кошелька. В приложении это админский эндпоинт
                 <span class="font-mono text-xs">POST /api/v1/admin/freeze</span>, здесь — переключатель.
               </p>
               ${toggle(s.frozen, "toggle-freeze")}
             </div>
           </div>

           ${noticeBlocks()}`,
          "space-y-6",
        ),
    );
  }

  function dashboardPage() {
    const s = state.session;
    const remaining = spendingRemaining(s);
    const hasLimit = s.rules.limitWei > 0n;
    const spent = hasLimit && remaining !== null ? s.rules.limitWei - remaining : 0n;
    const usedPercent = hasLimit ? Number((spent * 100n) / s.rules.limitWei) : 0;

    const limitCard = card(
      cardHeader(
        `${cardTitle("Лимит трат", "text-base font-semibold")}
         ${button("Настроить", {variant: "outline", size: "sm", href: "#/settings"})}`,
        "flex flex-row items-center justify-between space-y-0 pb-4",
      ) +
        cardContent(
          hasLimit
            ? `<div>
                 <p class="text-xs text-muted-foreground">Лимит ${formatPeriod(Number(s.rules.periodSeconds))}</p>
                 <p class="text-2xl font-bold tabular-nums tracking-tight">
                   ${formatEth(s.rules.limitWei)} <span class="text-sm font-normal text-muted-foreground">ETH</span>
                 </p>
               </div>
               ${progress(usedPercent)}
               <div class="flex items-center justify-between text-sm">
                 <div>
                   <p class="text-xs text-muted-foreground">Потрачено в окне</p>
                   <p class="font-semibold tabular-nums">${formatEth(spent)} ETH</p>
                 </div>
                 <div class="text-right">
                   <p class="text-xs text-muted-foreground">Осталось</p>
                   <p class="font-semibold tabular-nums">${formatEth(remaining ?? 0n)} ETH</p>
                 </div>
               </div>`
            : `<p class="text-sm text-muted-foreground">
                 Лимит не задан — агент тратит в пределах баланса.${
                   s.rules.whitelistEnabled ? " Действует whitelist получателей." : ""
                 }
               </p>`,
          "space-y-4",
        ),
    );

    const recent = card(
      cardHeader(
        `${cardTitle("Последние транзакции", "text-base font-semibold")}
         ${button("Вся история", {variant: "outline", size: "sm", href: "#/transactions"})}`,
        "flex flex-row items-center justify-between space-y-0 pb-4",
      ) +
        cardContent(
          s.txs.length === 0
            ? `<p class="py-8 text-center text-sm text-muted-foreground">Агент ещё ничего не потратил.</p>`
            : `<div class="divide-y">
                 ${s.txs
                   .slice(0, 8)
                   .map(
                     (tx) => `
                   <div class="flex items-center gap-4 py-3">
                     <div class="min-w-0 flex-1">
                       <p class="font-mono text-sm">${shortAddress(tx.to)}</p>
                       <p class="mt-0.5 text-xs text-muted-foreground">${timeAgo(tx.timestamp)}</p>
                     </div>
                     <p class="shrink-0 text-sm font-semibold tabular-nums">−${formatEth(tx.valueWei)} ETH</p>
                   </div>`,
                   )
                   .join("")}
               </div>`,
        ),
    );

    return `
      <div class="space-y-6">
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="text-2xl font-medium tracking-tight">${esc(s.handle)}</h1>
          ${badge(MODE_LABEL[s.mode])}
          ${s.frozen ? badge(`${icon("snowflake", "size-3")}Заморожен`, "destructive", "gap-1") : ""}
        </div>

        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          ${statCard("wallet", "Баланс кошелька", `${formatEth(s.balanceWei)} ETH`, "Доступно агенту для трат")}
          ${statCard("shield-check", "Депозит на газ", `${formatEth(s.gasDepositWei)} ETH`, "Средства в EntryPoint на оплату операций")}
          ${statCard("arrow-left-right", "Транзакций", String(s.txs.length), `${plural(s.txs.length, "запись", "записи", "записей")} в публичном логе`)}
        </div>

        <div class="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div class="space-y-6">
            ${s.mode === "HUMAN_CUSTODIAN" ? limitCard : ""}
            ${recent}
          </div>
          ${walletActions()}
        </div>
      </div>`;
  }

  function transactionsPage() {
    const s = state.session;
    return `
      <div class="space-y-6">
        <div>
          <h1 class="text-2xl font-medium tracking-tight">Транзакции</h1>
          <p class="mt-2 text-sm text-muted-foreground">
            Публичный лог кошелька: кто, когда, сколько и кому. Данные читаются из событий
            контракта, а не из внутренней базы.
          </p>
        </div>
        ${card(
          cardContent(
            s.txs.length === 0
              ? `<p class="py-12 text-center text-sm text-muted-foreground">История пуста. Первая трата появится здесь автоматически.</p>`
              : `<div class="overflow-x-auto"><div data-slot="table-container" class="${T.tableWrap}">
                   <table data-slot="table" class="${T.table}">
                     <thead data-slot="table-header" class="${T.thead}">
                       <tr data-slot="table-row" class="${T.tr}">
                         <th data-slot="table-head" class="${T.th}">Получатель</th>
                         <th data-slot="table-head" class="${T.th} hidden md:table-cell">Транзакция</th>
                         <th data-slot="table-head" class="${T.th} hidden sm:table-cell">Блок</th>
                         <th data-slot="table-head" class="${T.th}">Время</th>
                         <th data-slot="table-head" class="${T.th} text-right">Сумма</th>
                       </tr>
                     </thead>
                     <tbody data-slot="table-body" class="${T.tbody}">
                       ${s.txs
                         .map(
                           (tx) => `
                         <tr data-slot="table-row" class="${T.tr}">
                           <td data-slot="table-cell" class="${T.td} font-mono text-sm">${shortAddress(tx.to)}</td>
                           <td data-slot="table-cell" class="${T.td} hidden font-mono text-xs text-muted-foreground md:table-cell">${shortAddress(tx.txHash)}</td>
                           <td data-slot="table-cell" class="${T.td} hidden tabular-nums text-muted-foreground sm:table-cell">${tx.blockNumber}</td>
                           <td data-slot="table-cell" class="${T.td} text-sm text-muted-foreground">${tx.timestamp.toLocaleString("ru-RU")}</td>
                           <td data-slot="table-cell" class="${T.td} text-right font-semibold tabular-nums">${formatEth(tx.valueWei)} ETH</td>
                         </tr>`,
                         )
                         .join("")}
                     </tbody>
                   </table>
                 </div></div>`,
            "pt-6",
          ),
        )}
      </div>`;
  }

  function settingsPage() {
    const s = state.session;

    if (s.mode === "AUTONOMOUS_ENTITY") {
      return `
        <div class="space-y-6">
          <div>
            <h1 class="text-2xl font-medium tracking-tight">Правила</h1>
            <p class="mt-2 text-sm text-muted-foreground">
              Ограничения исполняет контракт кошелька, а не приложение: обойти их через API невозможно.
            </p>
          </div>
          ${card(
            cardContent(
              `<p class="text-sm font-medium">Это автономный агент</p>
               <p class="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                 У кошелька нет кастодиана, поэтому правил не существует — не только в
                 интерфейсе, но и в самом контракте. Такой агент распоряжается средствами
                 полностью самостоятельно.
               </p>`,
              "py-12 text-center",
            ),
          )}
        </div>`;
    }

    const whitelistRows = s.whitelist.length
      ? `<div class="divide-y rounded-lg border">
           ${s.whitelist
             .map(
               (addr) => `<div class="flex items-center justify-between gap-3 px-3 py-2">
                 <span class="truncate font-mono text-xs">${addr}</span>
                 <span class="shrink-0 text-xs text-muted-foreground">разрешён</span>
               </div>`,
             )
             .join("")}
         </div>`
      : `<p class="text-xs text-muted-foreground">Список пуст.</p>`;

    return `
      <div class="space-y-6">
        <div>
          <h1 class="text-2xl font-medium tracking-tight">Правила</h1>
          <p class="mt-2 text-sm text-muted-foreground">
            Ограничения исполняет контракт кошелька, а не приложение: обойти их через API невозможно.
          </p>
        </div>

        ${card(
          cardHeader(cardTitle("Лимит трат", "text-base font-semibold"), "pb-4") +
            cardContent(
              `<div class="grid gap-4 sm:grid-cols-2">
                 <div class="space-y-2">
                   <label for="rules-limit" class="text-sm">Лимит, ETH (0 — без ограничения)</label>
                   ${input({id: "rules-limit", model: "rules.limitEth", value: state.rules.limitEth, inputmode: "decimal", placeholder: "0"})}
                 </div>
                 <div class="space-y-2">
                   <span class="text-sm">Период</span>
                   <div class="flex flex-wrap gap-2">
                     ${PERIODS.map(([value, label]) =>
                       button(label, {
                         variant: state.rules.periodSeconds === value ? "default" : "outline",
                         size: "sm",
                         act: `rules-period:${value}`,
                       }),
                     ).join("")}
                   </div>
                 </div>
               </div>

               <div class="flex items-start justify-between gap-4 border-t pt-6">
                 <div>
                   <p class="text-sm">Только разрешённые получатели</p>
                   <p class="mt-1 text-xs text-muted-foreground">Платежи вне whitelist откатываются контрактом.</p>
                 </div>
                 ${toggle(state.rules.whitelistEnabled, "rules-whitelist-toggle")}
               </div>

               ${button("Сохранить правила", {act: "save-rules"})}`,
              "space-y-6",
            ),
        )}

        ${card(
          cardHeader(cardTitle("Whitelist получателей", "text-base font-semibold"), "pb-4") +
            cardContent(
              `${input({model: "form.target", value: state.form.target, placeholder: "0x… адрес", extra: "font-mono text-sm", label: "Адрес получателя"})}
               <div class="flex flex-wrap gap-2">
                 ${button("Разрешить", {variant: "outline", act: "whitelist-allow"})}
                 ${button("Запретить", {variant: "outline", act: "whitelist-deny"})}
                 ${button("Подставить демо-адрес", {variant: "outline", act: "fill-target"})}
               </div>
               ${whitelistRows}
               <p class="text-xs text-muted-foreground">
                 Список хранится в контракте кошелька; изменение — отдельная транзакция.
               </p>`,
              "space-y-4",
            ),
        )}

        ${noticeBlocks()}
      </div>`;
  }

  function showcasePage() {
    const agentCards = state.agents.length
      ? `<div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
           ${state.agents
             .map((agent) =>
               card(
                 cardContent(
                   `<div class="flex items-center justify-between">
                      <div class="flex size-9 items-center justify-center rounded-lg bg-muted">
                        ${icon(agent.mode === "AUTONOMOUS_ENTITY" ? "bot" : "user-round", "size-4 text-muted-foreground")}
                      </div>
                      ${badge(MODE_LABEL[agent.mode], "secondary", "text-xs font-normal")}
                    </div>
                    <p class="mt-4 font-medium">${esc(agent.handle)}</p>
                    <p class="mt-1 font-mono text-xs text-muted-foreground">${shortAddress(agent.account)}</p>
                    <div class="mt-4 flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
                      <span>${plural(agent.txCount, "транзакция", "транзакции", "транзакций")}</span>
                      <span>${timeAgo(agent.createdAt)}</span>
                    </div>`,
                   "pt-6",
                 ),
                 "border-border/60",
               ),
             )
             .join("")}
         </div>`
      : `<div class="mt-6 rounded-xl border border-dashed p-10 text-center">
           <p class="text-sm text-muted-foreground">Пока никто не зарегистрирован. Ваш агент может быть первым.</p>
         </div>`;

    return `
      <div class="mx-auto max-w-6xl px-6 py-20">
        <div class="max-w-2xl">
          <h1 class="text-3xl font-medium tracking-tight sm:text-4xl">Витрина агентов</h1>
          <p class="mt-4 text-muted-foreground">
            Здесь видно, что агенты делают, и не видно, кто за ними стоит. Публичное имя,
            усечённый адрес, сумма — этого достаточно, чтобы доверять действию.
          </p>
        </div>

        <section class="mt-16">
          <h2 class="text-sm font-medium uppercase tracking-wider text-muted-foreground">Активные агенты</h2>
          ${agentCards}
        </section>

        <section class="mt-16">
          <h2 class="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">Живая лента трат</h2>
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <button type="button" data-act="toggle-live" class="flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <span class="${
                  state.live
                    ? "size-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/20"
                    : "size-2 rounded-full bg-muted-foreground/50"
                }"></span>
                ${state.live ? "Обновляется в реальном времени" : "Обновление приостановлено"}
              </button>
              <span class="text-xs text-muted-foreground">${plural(state.feed.length, "запись", "записи", "записей")}</span>
            </div>
            ${transactionFeed(state.feed.slice(0, 30))}
          </div>
        </section>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Роутер и рендер
  // ---------------------------------------------------------------------

  const DEMO_BANNER = `
    <div class="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center">
      <p class="text-xs text-amber-200">
        Демо: данные живут в памяти вкладки, блокчейн и бэкенд не подключены.
        Перезагрузка сбрасывает состояние.
      </p>
    </div>`;

  function currentRoute() {
    const hash = location.hash.replace(/^#/, "") || "/";
    return "#" + hash.split("#")[0];
  }

  const APP_ROUTES = ["#/dashboard", "#/transactions", "#/settings"];

  function render() {
    const route = currentRoute();

    if (APP_ROUTES.includes(route) && !state.session) {
      location.hash = "#/register";
      return;
    }

    let html;
    if (APP_ROUTES.includes(route)) {
      const page =
        route === "#/dashboard" ? dashboardPage() : route === "#/transactions" ? transactionsPage() : settingsPage();
      html = DEMO_BANNER + appShell(page, route);
    } else {
      const page = route === "#/register" ? registerPage() : route === "#/showcase" ? showcasePage() : landing();
      html = `${DEMO_BANNER}
        <div class="flex min-h-screen flex-col">
          ${siteHeader()}
          <main class="flex-1">${page}</main>
          ${siteFooter()}
        </div>`;
    }

    document.getElementById("app").innerHTML = html;

    // Якорные ссылки лендинга: прокрутка вручную, роутер съедает второй #.
    const anchor = location.hash.split("#")[2];
    if (anchor) {
      document.getElementById(anchor)?.scrollIntoView({behavior: "smooth"});
    }
  }

  // ---------------------------------------------------------------------
  // События
  // ---------------------------------------------------------------------

  /**
   * Состояния контролов, зависящие от введённого текста.
   *
   * Ввод намеренно не перерисовывает страницу — иначе фокус слетал бы на каждом
   * символе. Но кнопка отправки формы зависит от содержимого поля, поэтому её
   * состояние обновляется точечно, без перерисовки.
   */
  function syncControls() {
    const submit = document.querySelector('[data-act="register-submit"]');
    if (submit) {
      submit.disabled = state.reg.pending || state.reg.handle.trim().length < 2;
    }
  }

  document.addEventListener("input", (event) => {
    const path = event.target.dataset?.model;
    if (!path) return;
    const [group, key] = path.split(".");
    state[group][key] = event.target.value;
    syncControls();
  });

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-act]");
    if (!trigger) return;
    const [act, arg] = trigger.dataset.act.split(":");

    switch (act) {
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
        return createAgent();
      case "copy-key":
        navigator.clipboard?.writeText(state.reg.created.apiKey);
        trigger.innerHTML = `${icon("check", "size-3.5")}Скопировано`;
        return;
      case "go-dashboard":
        location.hash = "#/dashboard";
        return;
      case "deposit":
        return deposit();
      case "send":
        return sendPayment();
      case "fill-merchant":
        state.form.to = MERCHANT;
        return render();
      case "fill-target":
        state.form.target = MERCHANT;
        return render();
      case "toggle-freeze":
        state.session.frozen = !state.session.frozen;
        state.notice = state.session.frozen ? "Кошелёк заморожен." : "Кошелёк разморожен.";
        state.error = null;
        return render();
      case "rules-period":
        state.rules.periodSeconds = Number(arg);
        return render();
      case "rules-whitelist-toggle":
        state.rules.whitelistEnabled = !state.rules.whitelistEnabled;
        return render();
      case "save-rules":
        return saveRules();
      case "whitelist-allow":
        return setWhitelisted(true);
      case "whitelist-deny":
        return setWhitelisted(false);
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
    window.scrollTo({top: 0});
  });

  /**
   * Витрина должна выглядеть живой: раз в 14 секунд один из демо-агентов совершает
   * трату. Собственный кошелёк посетителя эта имитация не трогает.
   */
  setInterval(() => {
    if (!state.live || state.agents.length === 0) return;

    const pool = state.agents.filter((a) => !state.session || a.account !== state.session.account);
    if (pool.length === 0) return;

    const agent = pool[Math.floor(Math.random() * pool.length)];
    const value = parseEth((0.01 + Math.random() * 0.4).toFixed(3));

    state.feed.unshift({
      handle: agent.handle,
      mode: agent.mode,
      to: shortAddress(randomAddress()),
      valueWei: value,
      txHash: randomTxHash(),
      timestamp: new Date(),
    });
    agent.txCount += 1;
    state.feed = state.feed.slice(0, 40);

    if (["#/showcase", "#/"].includes(currentRoute())) render();
  }, 14000);

  render();
})();
