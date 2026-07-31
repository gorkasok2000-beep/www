// ---------------------------------------------------------------------
// Панель оператора
// ---------------------------------------------------------------------

/**
 * Пополнение и заморозка живут здесь, а не в кабинете агента, потому что это
 * действия платформы, а не владельца кошелька. В настоящем API за ними стоит
 * `POST /api/v1/admin/freeze` с админ-токеном и тестовый кран оператора.
 */

const ADMIN_USER = "admin";
const ADMIN_PASSWORD = "admin";

function adminLoginPage() {
  return `<div class="mx-auto max-w-md px-6 py-20">
    <div class="mb-10 text-center">
      <div class="mx-auto flex size-12 items-center justify-center rounded-xl bg-muted">
        ${icon("shield-alert", "size-6 text-muted-foreground")}
      </div>
      <h1 class="mt-6 text-3xl font-medium tracking-tight">Панель оператора</h1>
      <p class="mt-3 text-sm text-muted-foreground">
        Выдача тестовых средств и заморозка кошельков. Доступ только по служебной учётной записи.
      </p>
    </div>

    ${card(
      cardContent(
        `<div class="space-y-2">
           <label for="admin-user" class="text-sm">Логин</label>
           ${input({id: "admin-user", model: "adminForm.user", value: state.adminForm.user, placeholder: "admin", autocomplete: "username"})}
         </div>
         <div class="space-y-2">
           <label for="admin-pass" class="text-sm">Пароль</label>
           ${input({id: "admin-pass", model: "adminForm.password", value: state.adminForm.password, type: "password", autocomplete: "current-password"})}
         </div>

         ${errorBlock(state.adminForm.error)}

         ${button(state.adminForm.pending ? "Проверяем…" : "Войти", {
           size: "lg",
           act: "admin-login",
           pending: state.adminForm.pending,
           extra: "w-full justify-center",
         })}

         <p class="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
           Демонстрационный стенд: логин <span class="font-mono">admin</span>,
           пароль <span class="font-mono">admin</span>.
         </p>`,
        "space-y-5 pt-6",
      ),
    )}

    <p class="mt-6 text-center text-xs text-muted-foreground">
      <a href="#/" class="underline underline-offset-4 hover:text-foreground">Вернуться на сайт</a>
    </p>
  </div>`;
}

function adminPanelPage() {
  const query = state.adminForm.query.trim().toLowerCase();
  const rows = allWallets().filter((w) => !query || w.handle.toLowerCase().includes(query));

  const totalBalance = allWallets().reduce((sum, w) => sum + w.balanceWei, 0n);
  const frozenCount = allWallets().filter((w) => w.frozen).length;

  return `
    <div class="min-h-screen bg-background">
      <header class="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div class="mx-auto flex h-16 max-w-6xl items-center gap-3 px-6">
          <div class="flex size-8 items-center justify-center rounded-lg bg-muted">
            ${icon("shield-alert", "size-4 text-muted-foreground")}
          </div>
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold">Панель оператора</p>
            <p class="truncate text-xs text-muted-foreground">Synth Wallet · тестовая сеть</p>
          </div>
          <div class="ml-auto flex items-center gap-2">
            ${button("На сайт", {variant: "ghost", size: "sm", href: "#/"})}
            ${button(`${icon("log-out", "size-3.5")}Выйти`, {
              variant: "outline",
              size: "sm",
              act: "admin-logout",
              extra: "gap-1.5",
            })}
          </div>
        </div>
      </header>

      <div class="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div class="grid gap-4 sm:grid-cols-3">
          ${statCard("bot", "Агентов", String(allWallets().length), "Зарегистрировано в реестре")}
          ${statCard("wallet", "Средств на кошельках", `${formatEth(totalBalance)} ETH`, "Суммарный баланс")}
          ${statCard("snowflake", "Заморожено", String(frozenCount), "Кошельков с остановленными тратами")}
        </div>

        ${feedback()}

        ${card(
          cardHeader(
            `${cardTitle("Кошельки агентов", "text-base font-semibold")}
             <div class="flex items-center gap-2">
               <div class="w-40">
                 ${input({
                   model: "adminForm.query",
                   value: state.adminForm.query,
                   placeholder: "поиск по имени",
                   label: "Поиск по имени агента",
                 })}
               </div>
             </div>`,
            "flex flex-row items-center justify-between space-y-0 pb-4",
          ) +
            cardContent(
              rows.length === 0
                ? `<p class="py-12 text-center text-sm text-muted-foreground">Ничего не найдено.</p>`
                : `<div class="space-y-3">
                     <div class="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
                       <span class="text-xs text-muted-foreground">Сумма пополнения, ETH</span>
                       <div class="w-24">
                         ${input({
                           model: "adminForm.amount",
                           value: state.adminForm.amount,
                           inputmode: "decimal",
                           label: "Сумма пополнения в ETH",
                         })}
                       </div>
                       <span class="text-xs text-muted-foreground">применяется к кнопке «Пополнить» в строке</span>
                     </div>

                     <div class="divide-y">
                       ${rows
                         .map(
                           (w, i) => `
                         <div class="sw-item flex flex-wrap items-center gap-3 py-3" ${stagger(i)}>
                           <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                             ${icon(w.mode === "AUTONOMOUS_ENTITY" ? "bot" : "user-round", "size-4 text-muted-foreground")}
                           </div>

                           <div class="min-w-0 flex-1">
                             <div class="flex flex-wrap items-center gap-2">
                               <span class="truncate text-sm font-medium">${esc(w.handle)}</span>
                               ${w.frozen ? badge("Заморожен", "destructive", "text-xs font-normal") : ""}
                               ${state.session === w.handle ? badge("Вы", "outline", "text-xs font-normal") : ""}
                             </div>
                             <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">${w.account}</p>
                           </div>

                           <div class="shrink-0 text-right">
                             <p class="text-sm font-semibold tabular-nums">${formatEth(w.balanceWei)} ETH</p>
                             <p class="mt-0.5 text-xs text-muted-foreground">${plural(w.txs.length, "трата", "траты", "трат")}</p>
                           </div>

                           <div class="flex shrink-0 gap-2">
                             ${button(`${icon("plus", "size-3.5")}Пополнить`, {
                               variant: "outline",
                               size: "sm",
                               act: "admin-credit",
                               arg: w.handle,
                               extra: "gap-1.5",
                             })}
                             ${button(
                               w.frozen ? "Разморозить" : "Заморозить",
                               {
                                 variant: "outline",
                                 size: "sm",
                                 act: "admin-freeze",
                                 arg: w.handle,
                               },
                             )}
                           </div>
                         </div>`,
                         )
                         .join("")}
                     </div>
                   </div>`,
              "pt-6",
            ),
        )}

        <div class="grid gap-6 lg:grid-cols-[1fr_360px]">
          ${card(
            cardHeader(cardTitle("Журнал действий", "text-base font-semibold"), "pb-4") +
              cardContent(
                state.adminLog.length === 0
                  ? `<p class="py-8 text-center text-sm text-muted-foreground">Пока пусто. Действия оператора появятся здесь.</p>`
                  : `<div class="divide-y">
                       ${state.adminLog
                         .map(
                           (entry) => `
                         <div class="flex items-center gap-3 py-2.5">
                           <span class="min-w-0 flex-1 truncate text-sm">${esc(entry.text)}</span>
                           <span class="shrink-0 text-xs text-muted-foreground">${timeAgo(entry.at)}</span>
                         </div>`,
                         )
                         .join("")}
                     </div>`,
              ),
          )}

          ${card(
            cardHeader(cardTitle("Стенд", "text-base font-semibold"), "pb-4") +
              cardContent(
                `<p class="text-xs leading-relaxed text-muted-foreground">
                   Сброс вернёт демо-агентов в исходное состояние и удалит зарегистрированные
                   кошельки вместе с их keystore из этого браузера. Действие необратимо.
                 </p>
                 ${button(`${icon("rotate-ccw", "size-3.5")}Сбросить демо-данные`, {
                   variant: "outline",
                   act: "admin-reset",
                   extra: "gap-1.5",
                 })}`,
                "space-y-3",
              ),
          )}
        </div>
      </div>
    </div>`;
}

function adminLog(text) {
  state.adminLog.unshift({text, at: new Date()});
  state.adminLog = state.adminLog.slice(0, 20);
}
