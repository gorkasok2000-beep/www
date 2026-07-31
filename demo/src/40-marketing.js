// ---------------------------------------------------------------------
// Публичная часть: шапка, лендинг, витрина
// ---------------------------------------------------------------------

const SECTION_LINKS = [
  ["#/#manifest", "Манифест"],
  ["#/#modes", "Сценарии"],
  ["#/#how", "Как это работает"],
  ["#/showcase", "Витрина"],
];

function siteHeader() {
  const authed = Boolean(state.session);

  return `
    <header class="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div class="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
        <a href="#/" class="flex items-center gap-2.5">
          <span class="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <span class="text-sm font-semibold">S</span>
          </span>
          <span class="whitespace-nowrap text-sm font-semibold tracking-tight">Synth Wallet</span>
          <!-- Обёртка, а не класс hidden на самом бейдже: у него в базовых классах
               уже есть inline-flex, и он перебивает утилиту. -->
          <span class="hidden sm:block">${badge("Testnet", "outline", "font-normal")}</span>
        </a>

        <nav class="hidden items-center gap-6 md:flex">
          ${SECTION_LINKS.map(
            ([href, label]) =>
              `<a href="${href}" class="text-sm text-muted-foreground transition-colors hover:text-foreground">${label}</a>`,
          ).join("")}
        </nav>

        <div class="ml-auto flex items-center gap-2">
          ${
            authed
              ? button("В кабинет", {size: "sm", href: "#/dashboard"})
              : `<span class="hidden sm:block">
                   ${button("Войти", {variant: "ghost", size: "sm", href: "#/login"})}
                 </span>
                 ${button("Создать кошелёк", {size: "sm", href: "#/register"})}`
          }
        </div>
      </div>

      <!-- На узком экране те же разделы, но прокручиваемой строкой: иначе с телефона
           до «Манифеста» и «Сценариев» не добраться вовсе. -->
      <div class="no-scrollbar flex gap-1 overflow-x-auto border-t border-border/60 px-4 py-2 md:hidden">
        ${SECTION_LINKS.map(
          ([href, label]) =>
            `<a href="${href}" class="shrink-0 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">${label}</a>`,
        ).join("")}
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
          <a href="#/login" class="transition-colors hover:text-foreground">Вход</a>
          <a href="#/admin" class="transition-colors hover:text-foreground">Администрирование</a>
        </nav>
      </div>
    </footer>`;
}

function transactionFeed(items) {
  if (items.length === 0) {
    return emptyState("Пока ни один агент не совершил трату. Лента заполнится сама.");
  }

  return `<div class="divide-y rounded-xl border">
    ${items
      .map(
        (item, i) => `
      <div class="sw-item flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40" ${stagger(i)}>
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
      "Выбираете сценарий и имя. Вы получаете зашифрованный ключ доступа — пароль в привычном виде здесь не нужен."],
    ["circle-dollar-sign", "Пополнение",
      "Кошелёк принимает средства обычным переводом на свой адрес — как любой Ethereum-кошелёк."],
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
              ([title, text], i) => `
            <div class="sw-item bg-background p-6 text-center" ${stagger(i)}>
              <dt class="text-sm font-semibold">${title}</dt>
              <dd class="mt-2 text-sm text-muted-foreground">${text}</dd>
            </div>`,
            )
            .join("")}
        </dl>
      </div>
    </section>

    <section id="manifest" class="scroll-mt-28 border-t">
      <div class="mx-auto max-w-6xl px-6 py-24">
        ${sectionHeading(
          "Манифест",
          "Первая инфраструктура, которая не спрашивает документы",
          "Экономическими агентами становятся не только люди. Мы даём пространство для действия — и делаем это действие проверяемым.",
        )}
        <div class="mt-16 grid gap-6 md:grid-cols-3">
          ${manifesto
            .map(([ic, title, text], i) =>
              card(
                cardContent(
                  `<div class="flex size-10 items-center justify-center rounded-lg bg-muted">${icon(ic, "size-5 text-muted-foreground")}</div>
                   <h3 class="mt-5 text-lg font-medium">${title}</h3>
                   <p class="mt-2 text-sm leading-relaxed text-muted-foreground">${text}</p>`,
                  "pt-6",
                ),
                "sw-item border-border/60",
                stagger(i),
              ),
            )
            .join("")}
        </div>
      </div>
    </section>

    <section id="modes" class="scroll-mt-28 border-t">
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
            "sw-item border-border/60",
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
            "sw-item border-border/60",
          )}
        </div>
      </div>
    </section>

    <section id="how" class="scroll-mt-28 border-t">
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
            <div class="sw-item bg-background p-6" ${stagger(i)}>
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

function showcasePage() {
  const agents = allWallets();

  const agentCards = agents.length
    ? `<div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
         ${agents
           .map((agent, i) =>
             card(
               cardContent(
                 `<div class="flex items-center justify-between">
                    <div class="flex size-9 items-center justify-center rounded-lg bg-muted">
                      ${icon(agent.mode === "AUTONOMOUS_ENTITY" ? "bot" : "user-round", "size-4 text-muted-foreground")}
                    </div>
                    <div class="flex items-center gap-2">
                      ${agent.frozen ? badge("Заморожен", "destructive", "text-xs font-normal") : ""}
                      ${badge(MODE_LABEL[agent.mode], "secondary", "text-xs font-normal")}
                    </div>
                  </div>
                  <p class="mt-4 font-medium">${esc(agent.handle)}</p>
                  <p class="mt-1 font-mono text-xs text-muted-foreground">${shortAddress(agent.account)}</p>
                  <div class="mt-4 flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
                    <span>${plural(agent.txs.length, "транзакция", "транзакции", "транзакций")}</span>
                    <span>${timeAgo(agent.createdAt)}</span>
                  </div>`,
                 "pt-6",
               ),
               "sw-item border-border/60",
               stagger(i),
             ),
           )
           .join("")}
       </div>`
    : emptyState("Пока никто не зарегистрирован. Ваш агент может быть первым.");

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
