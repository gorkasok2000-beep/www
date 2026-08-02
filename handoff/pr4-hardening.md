# PR-4: Индексатор, SSRF, валидация ввода, лимиты крана (M2, M3, M4, H6)

**Ветка:** `pr4-hardening` → `claude/synth-wallet-prototype-ox1cd0`
**Коммит:** `5ba70d7`
**Файлы (12):** `apps/web/src/lib/validate.ts`, `apps/web/src/lib/chain/signer.ts`, `apps/web/src/app/api/v1/agents/route.ts`, `apps/web/src/lib/chain/indexer.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/invoices.ts`, `apps/web/src/lib/session-keys.ts`, `apps/web/src/lib/env.ts`, `apps/web/src/lib/chain/registry.ts`, `apps/web/src/app/api/v1/agents/me/deposit/route.ts`, `apps/web/prisma/schema.prisma`, `.env.example`

## Что закрывает

### M2 — индексатор доверял topic0 без проверки эмитента

`getLogs` фильтровал только сигнатуру события: любой чужой контракт мог выпустить
поддельный `AgentTransaction` от имени нашего кошелька, и он попадал в кэш и на
витрину. Теперь каждый лог сверяется по `log.address` с адресом кошелька-эмитента —
событие обязан выпустить сам кошелёк (`indexer.ts`).

### M3 — SSRF через signerUrl

Раньше проверялась только схема URL. Теперь (`validate.ts`, `signer.ts`):

- запрещены логин/пароль в URL, `localhost` и приватные/служебные IP-литералы
  (10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, CGNAT, multicast, IPv6 ULA и
  link-local, IPv4-mapped);
- при регистрации домен резолвится через DNS, и **каждый** полученный адрес
  проверяется на приватность — фильтр по литералу больше не обходится доменом,
  указывающим на `127.0.0.1`;
- запрос подписи идёт с `redirect: "manual"`, а 3xx — ошибка: проверку нельзя
  обойти редиректом на внутренний адрес.

Оговорки честно зафиксированы в коде: DNS-rebinding между проверкой и запросом
остаётся теоретически возможен (полная защита — задача продакшена). На локальной
сети (`CHAIN_ID=31337`, anvil) приватные адреса разрешены — signerUrl агента при
разработке закономерно живёт на localhost.

### M4 — валидация ввода

- `parseValue` отклоняет отрицательный `valueEth` (`parseEther` его принимает);
- `parseRules.periodSeconds`: `NaN` и нецелые — 400 вместо 500 (`BigInt(NaN)`
  бросал `RangeError`);
- `ttlSeconds` в счетах и session keys: `NaN` — 400 (сравнения с `NaN` всегда
  ложны, и значение проскакивало в `validUntil`);
- 500-ответы больше не отдают наружу сырой `error.message` — детали остаются в
  серверном логе, клиент получает нейтральное «Внутренняя ошибка сервера.».

### H6 — открытый кран и газовые выдачи

- Флаг `FAUCET_ENABLED` (`.env.example`, `env.ts`): на публичной сети кран и
  выдача газа выключаются одной переменной. По умолчанию включён (локальная
  разработка).
- Суточный лимит крана на агента — 30 ETH (лимит одной выдачи 10 ETH сохранён).
  Новая модель `FaucetGrant`; проверка лимита и запись о выдаче — в одной
  транзакции с writer-lock (та же гонка, что была с платежами). Неудачная выдача
  возвращает лимит.
- Несгораемый резерв оператора 1 ETH: `fundAccount` отказывает, если после
  выдачи остаток оператора упал бы ниже резерва — кран физически не может
  вывести кошелёк в ноль.
- `ensureGasAllowance` (газ владельцам ключей/кастодианам) отключён вместе с
  краном: при `FAUCET_ENABLED=false` адрес пополняет сам владелец.

## Миграция

Новая таблица `FaucetGrant` — после применения патча:

```bash
cd apps/web
npx prisma db push
npx prisma generate
```

## Проверки

- `prisma generate` — клиент перегенерирован с `FaucetGrant`.
- `tsc --noEmit` по `apps/web` — чисто.
- `.diff` проверен применением поверх PR-3 (`git apply --check` — OK).
- ⚠️ Юнит-тестов у web-приложения нет; живой прогон (анvil + регистрация агента
  с внешним signerUrl, суточный лимит крана) — локально у владельца.

## Как применить

```bash
# вариант 1: patch поверх main после PR-3
git apply pr4-hardening.diff

# вариант 2: как коммит с сохранением сообщения
git am < pr4-hardening.patch
```

## Что дальше

Блок 5 по статус-странице: CI/DX — `.github/workflows` (pnpm build + forge test),
`tsconfig.tsbuildinfo` из git, README про сабмодули, `scripts/check-env.mjs`,
судьба сгенерированных артефактов в git. Из находок ревью остаются M1 (token
budgets — roadmap gate, осознанно отложен) и пакет low.
