// ---------------------------------------------------------------------
// Регистрация и вход
// ---------------------------------------------------------------------

const PERIODS = [
  [0, "за транзакцию"],
  [3600, "в час"],
  [86400, "в сутки"],
  [604800, "в неделю"],
];

function modeCard(selected, act, ic, badgeText, title, text) {
  return `<button type="button" data-act="${act}" class="w-full text-left">
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
      `h-full transition-all duration-200 ${
        selected
          ? "border-foreground/40 bg-muted/40 ring-foreground/30"
          : "border-border/60 hover:border-border hover:bg-muted/20"
      }`,
    )}
  </button>`;
}

function registerPage() {
  const reg = state.reg;

  if (reg.created) {
    return registrationResult(reg.created);
  }

  const custodial = reg.mode === "HUMAN_CUSTODIAN";
  const passphraseTooShort = reg.passphrase.length > 0 && reg.passphrase.length < 8;
  const mismatch = reg.passphrase2.length > 0 && reg.passphrase !== reg.passphrase2;

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
      <div class="sw-fade space-y-8">
        <div class="space-y-2">
          <label for="handle" class="text-sm font-medium">Публичное имя агента</label>
          ${input({id: "handle", model: "reg.handle", value: reg.handle, placeholder: "orion"})}
          <p class="text-xs text-muted-foreground">
            Под этим именем агент появится в публичной витрине. Латиница, цифры и дефис.
          </p>
        </div>

        <div class="space-y-6 rounded-xl border p-6">
          <div>
            <h3 class="text-sm font-medium">Парольная фраза</h3>
            <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
              Ею шифруется ключ агента. Она не уходит с устройства и нигде не хранится —
              ни у нас, ни в файле keystore. Восстановить её невозможно: забудете —
              останется только ключ доступа, который мы покажем следующим шагом.
            </p>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <label for="pass1" class="text-sm">Парольная фраза</label>
              ${input({id: "pass1", model: "reg.passphrase", value: reg.passphrase, type: "password", placeholder: "не короче 8 символов", autocomplete: "new-password"})}
              ${passphraseTooShort ? `<p class="text-xs text-destructive">Минимум 8 символов.</p>` : ""}
            </div>
            <div class="space-y-2">
              <label for="pass2" class="text-sm">Повторите</label>
              ${input({id: "pass2", model: "reg.passphrase2", value: reg.passphrase2, type: "password", autocomplete: "new-password"})}
              ${mismatch ? `<p class="text-xs text-destructive">Фразы не совпадают.</p>` : ""}
            </div>
          </div>
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
                    act: "reg-period",
                    arg: String(value),
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
              ? `<div class="sw-fade space-y-2">
                   <label for="whitelist" class="text-sm">Адреса через запятую или с новой строки</label>
                   <textarea id="whitelist" data-model="reg.whitelist" rows="3"
                     placeholder="${MERCHANT}"
                     class="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring">${esc(reg.whitelist)}</textarea>
                 </div>`
              : ""
          }
        </div>`
            : ""
        }

        ${errorBlock(reg.error)}

        ${button(reg.pending ? "Шифруем ключ…" : "Создать кошелёк", {
          size: "lg",
          act: "register-submit",
          pending: reg.pending,
          disabled: reg.handle.trim().length < 2 || reg.passphrase.length < 8 || mismatch,
        })}
      </div>`
          : ""
      }
    </div>
  </div>`;
}

function registrationResult(created) {
  const keystoreJson = JSON.stringify(created.keystore, null, 2);

  return `<div class="mx-auto max-w-3xl px-6 py-20">
    ${card(
      cardContent(
        `<div>
           ${badge("Кошелёк создан")}
           <h2 class="mt-4 text-2xl font-medium tracking-tight">${esc(created.handle)}</h2>
           <p class="mt-2 break-all font-mono text-sm text-muted-foreground">${created.account}</p>
         </div>

         <div class="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
           <p class="text-sm font-medium">Ключ доступа</p>
           <p class="text-xs leading-relaxed text-muted-foreground">
             Это и есть вход в кабинет вместо логина и пароля. Запишите его: показывается
             один раз, восстановить нельзя. Ключ открывает кошелёк сам по себе — храните
             его так же, как хранили бы деньги.
           </p>
           ${copyField(created.accessKey, {act: "copy"})}
         </div>

         <div class="space-y-3 rounded-xl border p-5">
           <p class="text-sm font-medium">Файл keystore</p>
           <p class="text-xs leading-relaxed text-muted-foreground">
             Тот же ключ, зашифрованный вашей парольной фразой (PBKDF2-SHA256 + AES-256-GCM).
             Копия уже сохранена в этом браузере — файл нужен, чтобы войти с другого устройства.
           </p>
           <div class="flex flex-wrap gap-2">
             ${button(`${icon("arrow-down-to-line", "size-3.5")}Скачать keystore`, {
               variant: "outline",
               size: "sm",
               act: "download-keystore",
               extra: "gap-1.5",
             })}
             ${button("Показать содержимое", {variant: "outline", size: "sm", act: "toggle-keystore-json"})}
           </div>
           ${
             state.revealedKey === "keystore"
               ? `<pre class="sw-fade overflow-x-auto rounded-md border bg-background p-3 font-mono text-[11px] leading-relaxed">${esc(keystoreJson)}</pre>`
               : ""
           }
         </div>

         <div class="space-y-3 rounded-xl border p-5">
           <p class="text-sm font-medium">Первый API-ключ</p>
           <p class="text-xs leading-relaxed text-muted-foreground">
             Им агент ходит в API. Дальше в кабинете останется только префикс —
             новые ключи выпускаются в разделе «API-ключи».
           </p>
           ${copyField(created.apiKey, {act: "copy"})}
         </div>

         <div class="rounded-xl border bg-muted/30 p-5">
           <p class="text-sm text-muted-foreground">Первая трата агента:</p>
           <pre class="mt-3 overflow-x-auto font-mono text-xs leading-relaxed"><code>curl -X POST /api/v1/agents/me/transactions \\
  -H "X-API-Key: ${esc(created.apiKey.slice(0, 20))}…" \\
  -d '{"to": "0x…", "valueEth": "0.05"}'</code></pre>
         </div>

         ${button("Открыть кабинет", {size: "lg", act: "go-dashboard"})}`,
        "space-y-8 pt-6",
      ),
    )}
  </div>`;
}

function loginPage() {
  const saved = Object.values(state.keystores);
  const byKey = state.login.mode === "accessKey";

  const tab = (active, label, mode) =>
    `<button type="button" data-act="login-mode" data-arg="${mode}"
       class="rounded-lg px-3 py-1.5 text-sm transition-colors ${
         active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
       }">${label}</button>`;

  return `<div class="mx-auto max-w-md px-6 py-20">
    <div class="mb-10 text-center">
      <h1 class="text-3xl font-medium tracking-tight">Вход в кабинет</h1>
      <p class="mt-3 text-sm text-muted-foreground">
        Логина и пароля здесь нет. Кабинет открывает ключ агента — расшифрованный
        парольной фразой или введённый напрямую.
      </p>
    </div>

    ${card(
      cardContent(
        `<div class="flex gap-1 rounded-lg border p-1">
           ${tab(!byKey, "По keystore", "keystore")}
           ${tab(byKey, "По ключу доступа", "accessKey")}
         </div>

         ${
           byKey
             ? `<div class="sw-fade space-y-2">
                  <label for="access-key" class="text-sm">Ключ доступа</label>
                  <textarea id="access-key" data-model="login.accessKey" rows="3"
                    placeholder="SYNTH-XXXXX-XXXXX-…"
                    class="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring">${esc(state.login.accessKey)}</textarea>
                  <p class="text-xs text-muted-foreground">
                    Парольная фраза не нужна: ключ доступа и есть сам ключ.
                  </p>
                </div>`
             : saved.length === 0
               ? emptyState("В этом браузере нет сохранённых кошельков. Войдите по ключу доступа или создайте новый кошелёк.")
               : `<div class="sw-fade space-y-4">
                    <div class="space-y-2">
                      <span class="text-sm">Кошелёк</span>
                      <div class="space-y-2">
                        ${saved
                          .map(
                            (ks) => `
                          <button type="button" data-act="login-pick" data-arg="${esc(ks.handle)}"
                            class="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                              state.login.handle === ks.handle
                                ? "border-foreground/40 bg-muted/40"
                                : "border-border/60 hover:bg-muted/20"
                            }">
                            <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                              ${icon(ks.mode === "AUTONOMOUS_ENTITY" ? "bot" : "user-round", "size-4 text-muted-foreground")}
                            </div>
                            <div class="min-w-0 flex-1">
                              <p class="truncate text-sm font-medium">${esc(ks.handle)}</p>
                              <p class="truncate font-mono text-xs text-muted-foreground">${shortAddress(ks.address)}</p>
                            </div>
                          </button>`,
                          )
                          .join("")}
                      </div>
                    </div>

                    <div class="space-y-2">
                      <label for="login-pass" class="text-sm">Парольная фраза</label>
                      ${input({id: "login-pass", model: "login.passphrase", value: state.login.passphrase, type: "password", autocomplete: "current-password"})}
                    </div>
                  </div>`
         }

         ${errorBlock(state.login.error)}

         ${button(state.login.pending ? "Расшифровываем…" : "Войти", {
           size: "lg",
           act: "login-submit",
           pending: state.login.pending,
           extra: "w-full justify-center",
           disabled: byKey
             ? state.login.accessKey.trim().length < 10
             : !state.login.handle || state.login.passphrase.length === 0,
         })}

         <p class="text-center text-xs text-muted-foreground">
           Нет кошелька? <a href="#/register" class="underline underline-offset-4 hover:text-foreground">Создать</a>
         </p>`,
        "space-y-6 pt-6",
      ),
    )}
  </div>`;
}
