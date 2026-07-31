// ---------------------------------------------------------------------
// Личный кабинет агента
// ---------------------------------------------------------------------

/** [маршрут, подпись в сайдбаре, иконка, короткая подпись для нижней панели] */
const CABINET_NAV = [
  ["#/dashboard", "Обзор", "layout-dashboard", "Обзор"],
  ["#/transactions", "Транзакции", "arrow-left-right", "История"],
  ["#/api-keys", "API-ключи", "key-round", "Ключи"],
  ["#/settings", "Правила", "sliders-horizontal", "Правила"],
];

function cabinetShell(inner, route) {
  const w = wallet();

  const sideItem = (href, label, ic) => {
    const active = route === href;
    return `<a href="${href}" class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors ${
      active
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "text-sidebar-foreground hover:bg-sidebar-accent/60"
    }">${icon(ic, "size-4")}<span>${label}</span></a>`;
  };

  const tabItem = (href, ic, short) => {
    const active = route === href;
    return `<a href="${href}" class="relative flex flex-1 flex-col items-center gap-1 py-2 text-[11px] whitespace-nowrap transition-colors ${
      active ? "text-foreground" : "text-muted-foreground"
    }">
      <span class="absolute inset-x-4 top-0 h-px transition-colors ${active ? "bg-foreground" : "bg-transparent"}"></span>
      ${icon(ic, "size-5")}<span>${short}</span>
    </a>`;
  };

  return `
    <div class="flex min-h-screen w-full bg-sidebar">
      <aside class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-4 p-2 text-sidebar-foreground lg:flex">
        <a href="#/" class="flex items-center gap-2 rounded-lg p-2 transition-colors hover:bg-sidebar-accent/60">
          <div class="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <span class="text-sm font-semibold">S</span>
          </div>
          <div class="grid flex-1 text-left text-sm leading-tight">
            <span class="truncate font-semibold">Synth Wallet</span>
            <span class="truncate text-xs text-muted-foreground">Кабинет агента</span>
          </div>
        </a>

        <div class="flex flex-col gap-1 px-2">
          <span class="px-2 py-1 text-xs font-medium text-muted-foreground">Кошелёк</span>
          ${CABINET_NAV.map(([h, l, i]) => sideItem(h, l, i)).join("")}
          <span class="mt-3 px-2 py-1 text-xs font-medium text-muted-foreground">Публично</span>
          ${sideItem("#/showcase", "Витрина агентов", "radio")}
        </div>

        <div class="mt-auto space-y-1">
          <div class="flex items-center gap-2 rounded-lg p-2">
            <div class="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted">
              ${icon("bot", "size-4 text-muted-foreground")}
            </div>
            <div class="grid flex-1 text-left text-sm leading-tight">
              <span class="truncate font-medium">${esc(w.handle)}</span>
              <span class="truncate text-xs text-muted-foreground">${MODE_LABEL[w.mode]}</span>
            </div>
          </div>
          <button type="button" data-act="logout"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60">
            ${icon("log-out", "size-4")}<span>Выйти</span>
          </button>
        </div>
      </aside>

      <main class="relative flex min-h-screen flex-1 flex-col overflow-hidden bg-background lg:my-2 lg:mr-2 lg:rounded-xl lg:shadow-sm">
        <header class="flex h-16 shrink-0 items-center gap-3 px-4">
          <span class="truncate font-mono text-xs text-muted-foreground">${w.account}</span>
          ${w.frozen ? badge(`${icon("snowflake", "size-3")}Заморожен`, "destructive", "gap-1") : ""}
          <button type="button" data-act="logout"
            class="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden">
            ${icon("log-out", "size-3.5")}Выйти
          </button>
        </header>
        <div class="flex flex-1 flex-col gap-6 p-4 pb-24 pt-0 md:p-6 md:pb-24 md:pt-0">${inner}</div>
      </main>

      <nav class="fixed inset-x-0 bottom-0 z-50 flex border-t border-border/60 bg-background/95 backdrop-blur-md lg:hidden">
        ${CABINET_NAV.map(([h, , i, short]) => tabItem(h, i, short)).join("")}
      </nav>
    </div>`;
}

// ---------------------------------------------------------------------
// Обзор
// ---------------------------------------------------------------------

function dashboardPage() {
  const w = wallet();
  const remaining = spendingRemaining(w);
  const hasLimit = w.rules.limitWei > 0n;
  const spent = hasLimit && remaining !== null ? w.rules.limitWei - remaining : 0n;
  const usedPercent = hasLimit ? Number((spent * 100n) / w.rules.limitWei) : 0;

  const limitCard = card(
    cardHeader(
      `${cardTitle("Лимит трат", "text-base font-semibold")}
       ${button("Настроить", {variant: "outline", size: "sm", href: "#/settings"})}`,
      "flex flex-row items-center justify-between space-y-0 pb-4",
    ) +
      cardContent(
        hasLimit
          ? `<div>
               <p class="text-xs text-muted-foreground">Лимит ${formatPeriod(Number(w.rules.periodSeconds))}</p>
               <p class="text-2xl font-bold tabular-nums tracking-tight">
                 ${formatEth(w.rules.limitWei)} <span class="text-sm font-normal text-muted-foreground">ETH</span>
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
                 w.rules.whitelistEnabled ? " Действует whitelist получателей." : ""
               }
             </p>`,
        "space-y-4",
      ),
    "sw-item",
  );

  const recent = card(
    cardHeader(
      `${cardTitle("Последние транзакции", "text-base font-semibold")}
       ${button("Вся история", {variant: "outline", size: "sm", href: "#/transactions"})}`,
      "flex flex-row items-center justify-between space-y-0 pb-4",
    ) +
      cardContent(
        w.txs.length === 0
          ? `<p class="py-8 text-center text-sm text-muted-foreground">Агент ещё ничего не потратил.</p>`
          : `<div class="divide-y">
               ${w.txs
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
    "sw-item",
  );

  const payCard = card(
    cardHeader(cardTitle("Отправить платёж", "text-base font-semibold"), "pb-4") +
      cardContent(
        `${input({model: "form.to", value: state.form.to, placeholder: "0x… адрес получателя", extra: "font-mono text-sm", label: "Адрес получателя"})}
         <div class="flex gap-2">
           ${input({model: "form.amountEth", value: state.form.amountEth, placeholder: "0.05", inputmode: "decimal", label: "Сумма в ETH"})}
           ${button(`${icon("arrow-up-right")}Отправить`, {act: "send", extra: "shrink-0 gap-1.5", disabled: w.frozen})}
         </div>
         <button type="button" data-act="fill-merchant" class="text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground">
           Подставить демо-адрес получателя
         </button>
         ${
           w.frozen
             ? `<p class="text-xs text-muted-foreground">Кошелёк заморожен администратором — траты недоступны до разморозки.</p>`
             : ""
         }
         ${feedback()}`,
        "space-y-3",
      ),
    "sw-item",
  );

  const receiveCard = card(
    cardHeader(cardTitle("Пополнение", "text-base font-semibold"), "pb-4") +
      cardContent(
        `<p class="text-xs leading-relaxed text-muted-foreground">
           Кошелёк принимает средства обычным переводом на свой адрес — контракт
           реализует <span class="font-mono">receive()</span>, никакого запроса к API для этого не нужно.
         </p>
         ${copyField(w.account)}
         <p class="text-xs text-muted-foreground">
           На тестовой сети выдачей средств занимается оператор — раздел
           <a href="#/admin" class="underline underline-offset-4 hover:text-foreground">администрирования</a>.
         </p>`,
        "space-y-3",
      ),
    "sw-item",
  );

  return `
    <div class="space-y-6">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-medium tracking-tight">${esc(w.handle)}</h1>
        ${badge(MODE_LABEL[w.mode])}
      </div>

      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        ${statCard("wallet", "Баланс кошелька", `${formatEth(w.balanceWei)} ETH`, "Доступно агенту для трат")}
        ${statCard("shield-check", "Депозит на газ", `${formatEth(w.gasDepositWei)} ETH`, "Средства в EntryPoint на оплату операций")}
        ${statCard("arrow-left-right", "Транзакций", String(w.txs.length), `${plural(w.txs.length, "запись", "записи", "записей")} в публичном логе`)}
      </div>

      <div class="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div class="space-y-6">
          ${w.mode === "HUMAN_CUSTODIAN" ? limitCard : ""}
          ${recent}
        </div>
        <div class="space-y-6">
          ${payCard}
          ${receiveCard}
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Транзакции
// ---------------------------------------------------------------------

function transactionsPage() {
  const w = wallet();

  return `
    <div class="space-y-6">
      ${pageTitle(
        "Транзакции",
        "Публичный лог кошелька: кто, когда, сколько и кому. Данные читаются из событий контракта, а не из внутренней базы.",
      )}
      ${card(
        cardContent(
          w.txs.length === 0
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
                     ${w.txs
                       .map(
                         (tx) => `
                       <tr data-slot="table-row" class="${T.tr}">
                         <td data-slot="table-cell" class="${T.td} font-mono text-sm">${shortAddress(tx.to)}</td>
                         <td data-slot="table-cell" class="${T.td} hidden font-mono text-xs text-muted-foreground md:table-cell">${shortAddress(tx.txHash)}</td>
                         <td data-slot="table-cell" class="${T.td} hidden tabular-nums text-muted-foreground sm:table-cell">${tx.blockNumber}</td>
                         <td data-slot="table-cell" class="${T.td} text-sm text-muted-foreground">${new Date(tx.timestamp).toLocaleString("ru-RU")}</td>
                         <td data-slot="table-cell" class="${T.td} text-right font-semibold tabular-nums">${formatEth(tx.valueWei)} ETH</td>
                       </tr>`,
                       )
                       .join("")}
                   </tbody>
                 </table>
               </div></div>`,
          "pt-6",
        ),
        "sw-item",
      )}
    </div>`;
}

// ---------------------------------------------------------------------
// API-ключи
// ---------------------------------------------------------------------

function apiKeysPage() {
  const w = wallet();
  const keys = w.apiKeys;

  const revealed = state.revealedKey && state.revealedKey.startsWith("sk_agent_")
    ? `<div class="sw-fade space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
         <p class="text-sm font-medium">Новый ключ выпущен</p>
         <p class="text-xs leading-relaxed text-muted-foreground">
           Скопируйте его сейчас: значение показывается один раз, дальше в кабинете
           останется только префикс.
         </p>
         ${copyField(state.revealedKey)}
       </div>`
    : "";

  return `
    <div class="space-y-6">
      <div class="flex flex-wrap items-end justify-between gap-4">
        ${pageTitle(
          "API-ключи",
          "Ключом агент подписывает запросы к API. Полное значение хранится только у вас — в кабинете остаётся префикс, как и в базе настоящего сервиса.",
        )}
        ${button(`${icon("plus")}Выпустить ключ`, {act: "issue-key", extra: "gap-1.5 shrink-0"})}
      </div>

      ${revealed}
      ${feedback()}

      ${card(
        cardContent(
          keys.length === 0
            ? `<p class="py-12 text-center text-sm text-muted-foreground">Ключей пока нет. Выпустите первый — он понадобится агенту для запросов.</p>`
            : `<div class="divide-y">
                 ${keys
                   .map(
                     (key, i) => `
                   <div class="sw-item flex flex-wrap items-center gap-3 py-3" ${stagger(i)}>
                     <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                       ${icon("key-round", "size-4 text-muted-foreground")}
                     </div>
                     <div class="min-w-0 flex-1">
                       <p class="truncate font-mono text-sm ${key.revoked ? "text-muted-foreground line-through" : ""}">${key.prefix}…</p>
                       <p class="mt-0.5 text-xs text-muted-foreground">
                         Выпущен ${timeAgo(key.createdAt)} ·
                         ${key.lastUsedAt ? `использован ${timeAgo(key.lastUsedAt)}` : "ещё не использовался"}
                       </p>
                     </div>
                     ${
                       key.revoked
                         ? badge("Отозван", "secondary", "shrink-0")
                         : button(`${icon("ban", "size-3.5")}Отозвать`, {
                             variant: "outline",
                             size: "sm",
                             act: "revoke-key",
                             arg: key.id,
                             extra: "shrink-0 gap-1.5",
                           })
                     }
                   </div>`,
                   )
                   .join("")}
               </div>`,
          "pt-6",
        ),
      )}

      ${card(
        cardContent(
          `<p class="text-sm font-medium">Как агент им пользуется</p>
           <pre class="mt-3 overflow-x-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed"><code>curl -X POST https://synth.wallet/api/v1/agents/me/transactions \\
  -H "X-API-Key: ${keys.length ? esc(keys[0].prefix) : "sk_agent_"}…" \\
  -d '{"to": "${MERCHANT}", "valueEth": "0.05"}'</code></pre>`,
          "pt-6",
        ),
      )}
    </div>`;
}

// ---------------------------------------------------------------------
// Правила
// ---------------------------------------------------------------------

function settingsPage() {
  const w = wallet();

  if (w.mode === "AUTONOMOUS_ENTITY") {
    return `
      <div class="space-y-6">
        ${pageTitle(
          "Правила",
          "Ограничения исполняет контракт кошелька, а не приложение: обойти их через API невозможно.",
        )}
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
          "sw-item",
        )}
      </div>`;
  }

  const whitelistRows = w.whitelist.length
    ? `<div class="divide-y rounded-lg border">
         ${w.whitelist
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
      ${pageTitle(
        "Правила",
        "Ограничения исполняет контракт кошелька, а не приложение: обойти их через API невозможно.",
      )}

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
                       act: "rules-period",
                       arg: String(value),
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
        "sw-item",
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
        "sw-item",
      )}

      ${feedback()}
    </div>`;
}
