# Synth Wallet — код-ревью и план совместной работы

Репозиторий: `https://github.com/gorkasok2000-beep/www`  
Ветка по умолчанию: `claude/synth-wallet-prototype-ox1cd0`  
Снимок на момент ревью: commit `27abf8508bf1f835793ee9591ff69d6677085918` (2026-08-01T03:47:21Z)  
Локальная копия: `/mnt/agents/output/www-repo` (импортирована через GitHub API tarball; инициализирован локальный git-бейзлайн `8be19d1` для будущих diff/patch).

## Как проверяли

- Статическое ревью контрактов, веб/API, DX/воспроизводимости.
- `forge`, `anvil`, `pnpm` в этой среде отсутствуют, а сабмодули `contracts/lib/*` в tarball пустые — тесты и сборку здесь не запускали. Выводы по Solidity сверялись с заявленным референсом `eth-infinitism/account-abstraction v0.9.0` и кодом проекта.
- Найденное делил на blocker/high/medium/low. Главный риск — не стиль, а реальные пути обхода ограничений и двойных трат.

## Короткий вердикт

Проект необычайно хорошо документирован: компромиссы MVP честно перечислены, архитектура понятна, платёжная идемпотентность продумана. Но есть один критический контрактный путь, который ломает саму идею session keys, и несколько серверных race/состояний, из-за которых «прототип без реальных денег» легко превращается в двойную трату при первом же RPC-флапе или конкурентном запросе.

Рекомендуемый первый шаг — не рефакторинг, а маленький security-пакет:
1) запретить session key вызывать `address(this)` и `entryPoint`;
2) не давать владельцу апгрейдить замороженный кошелёк;
3) починить серверную финализацию платежа после отправки.

---

## Blocker / Critical

### C1. Session key может эскалировать себя до полного контроля через self-call

**Файлы:** `contracts/src/AgentAccount.sol:218-263`, `contracts/src/lib/SessionKeys.sol:84-102`  
**Суть:** `_consumeSessionAllowance` проверяет только внешний селектор `userOp.callData` (`execute`/`executeBatch`). Внутренние вызовы при `targetsRestricted == false` ничем не ограничены. Атакующий с ограниченным ключом подписывает:

```text
execute(address(this), 0, abi.encodeCall(registerSessionKey, (attacker, 0, farFuture, uint128.max, [])))
```

Внешний селектор — `execute`, value = 0, бюджет не расходуется. При исполнении вызов идёт от `address(this)`, а в SimpleAccount/Owner-логике self-call считается владельцем. Дальше возможны:
- регистрация нового session key с произвольным бюджетом;
- `upgradeToAndCall` и полная замена имплементации;
- `withdrawDepositTo` / вывод депозита EntryPoint в обход бюджета.

Существующий тест `test_RevertWhen_SessionKeyRegistersAnotherKey` проверяет только прямой внешний селектор `registerSessionKey`, но не путь `execute(this, …)`.  
**Фикс:** в `_consumeSessionAllowance` для каждого вызова запретить `target == address(this)` и `target == address(entryPoint())`, плюс тесты на все вектора. Это маленькое изменение без миграции storage.

### B1. Прошедший в сети платёж может быть помечен `FAILED`, после чего агент заплатит второй раз

**Файл:** `apps/web/src/lib/payments.ts:127-186`  
**Суть:** после `submitUserOperation` в общем `try` остаются `readUserOperationOutcome`, `finalize`, `syncTransactionLogs`. Любая ошибка после фактической отправки (RPC-флап, сбой индексатора) попадает в общий `catch`, который безусловно ставит `FAILED`. Хуже того, `syncTransactionLogs()` идёт после успешного `finalize` и может перезаписать `CONFIRMED` на `FAILED`.  
`reconcilePayments` смотрит только `SUBMITTED`, поэтому ошибочный `FAILED` не исправляется. Агент видит неудачу и с новым ключом идемпотентности платит повторно.  
**Фикс:** разделить фазы: ошибки до отправки → `FAILED`; всё после `SUBMITTED` → оставлять `SUBMITTED` и дожидаться сверки; `syncTransactionLogs` — best-effort вне критичного `try`.

---

## High

### H1. Заморозка обходится владельцем через UUPS/прямые owner-вызовы

**Файл:** `contracts/src/AgentAccount.sol`  
Владелец замороженного кошелька может вызвать `upgradeToAndCall` и уйти на имплементацию без freeze/rules; `withdrawDepositTo` также не проверяет `frozen`. Для угрозы «мошенничество самого агента» заморозка сейчас не работает.  
**Минимум:** `require(!frozen)` в `_authorizeUpgrade`. **Лучше:** апгрейд только с одобрения кастодиана/реестра, либо явно документировать, что правила кастодиана не защищают от апгрейда владельцем.

### H2. Старые `sessionKeyTargets` никогда не удаляются

**Файл:** `contracts/src/AgentAccount.sol:319-354`  
Повторная выдача ключа обнуляет бюджет, но не снимает старые разрешённые получатели. `revokeSessionKey` тоже не чистит маппинг. «Перевыпуск с более узким списком» молча сохраняет старые адреса.  
**Фикс:** generation counter в `SessionKeys.Key`, ключ маппинга `(signer, generation, target)`; повторная выдача/отзыв атомарно инвалидирует старые targets. Добавить тест «перевыпуск сужает targets».

### H3. Сервер не различает события своей и чужих UserOperation

**Файл:** `apps/web/src/lib/chain/relayer.ts:193-219`  
`readUserOperationOutcome` сканирует все логи транзакции бандлера без фильтра по `userOpHash` и не смотрит `receipt.status`. В настоящем бандлере чужая failed op в том же bundle может сделать наш платёж `FAILED`, а полный revert bundle без событий может быть прочитан как `success: true`.  
**Фикс:** декодировать события только для `args.userOpHash === payment.userOpHash`; `receipt.status != success` → неуспех/неизвестно; «событий нет» ≠ успех.

### H4. Блокировка «один платёж за раз» не атомарна

**Файл:** `apps/web/src/lib/payments.ts:70-103`  
Проверка `IN_FLIGHT` и `payment.create` разделены await'ами. Два конкурентных платежа с разными ключами оба пройдут и оба возьмут один nonce — ровно та ошибка, которую комментарий обещает предотвратить.  
**Фикс:** сериализация на уровне БД (`BEGIN IMMEDIATE` для SQLite / эксклюзивная транзакция) или менеджер nonce.

### H5. Двойная оплата одного счёта

**Файлы:** `apps/web/src/app/api/v1/agents/me/transactions/route.ts:71-82`, `apps/web/src/lib/payments.ts:202-207`  
Счёт остаётся `OPEN` до финализации. Два разных агента или один агент с явным вторым ключом могут оплатить один счёт дважды.  
**Фикс:** атомарный захват счёта `OPEN -> PAYING` до исполнения, возврат в `OPEN` при неуспехе; в `finalize` закрывать только если счёт всё ещё захвачен этим платежом.

### H6. Открытый кран и газовые выдачи могут слить кошелёк оператора

**Файлы:** `apps/web/src/app/api/v1/agents/me/deposit/route.ts`, `apps/web/src/lib/chain/registry.ts:226-232`, `apps/web/src/lib/session-keys.ts:107`  
Регистрация открыта, депозит выдаёт до 10 ETH за запрос без суточных/per-agent лимитов; `ensureGasAllowance` может отправлять 0.05 ETH на произвольный owner EOA. На anvil безобидно, на публичном тестнете — финансовая дыра.  
**Фикс:** `FAUCET_ENABLED`, per-agent и глобальные лимиты, выдача газа только связанным действующим агентам.

### H7. Дублирующая регистрация одного аккаунта в реестре

**Файлы:** `contracts/src/AgentRegistry.sol:77-89`, `apps/web/src/lib/agents.ts:94-123`  
`factory.createAccount` идемпотентно вернёт существующий адрес при тех же params+salt; `AgentRegistry.registerAgent` создаст вторую запись и второй handle на один кошелёк. В вебе `salt` фиксирован `0n`, поэтому один autonomous owner может получить несколько handle на один account; при этом `db.agent.create` может упасть по unique `accountAddress` уже после успешной ончейн-регистрации.  
**Фикс:** в реестре отклонять уже зарегистрированный account; в вебе считать salt детерминированно/хранить его и обрабатывать «ончейн уже есть» как конфликт, а не как успех.

---

## Medium / Low (выборочно)

- **M1.** Бюджет session key считает только ETH `value`; ERC-20/ERC-721 выводятся calldata без расхода бюджета. Ограничение отмечено в коде, но README формулирует цену утечки слишком широко.
- **M2.** Индексатор `getLogs` фильтрует только topic0 события `AgentTransaction`, без проверки `log.address`/известных account — поддельное событие может попасть в кэш и витрину.
- **M3.** SSRF через `signerUrl`: проверяется только схема; нет DNS-резолва, запрета приватных диапазонов и `redirect: "manual"`.
- **M4.** `parseValue` пропускает отрицательный `valueEth`; `NaN` в ttl/period даёт 500 вместо 400; 500-ответы отдают наружу сырой `error.message`.
- **M5.** «Зомби»-платежи `CREATED` после падения процесса навсегда блокируют агента: новый платёж получает 409, ретрай возвращает старый `created`, сверка их не смотрит.
- **L.** `tsconfig.tsbuildinfo` закоммичен; `.github` CI отсутствует; сабмодули в tarball пустые и новому участнику нужен `git submodule update --init --recursive`; `docs/index.html` и `demo/synth-wallet-demo.html` — большие сгенерированные артефакты в git; cookie без `secure` для прода.

---

## Что сделано хорошо

- Очень сильная документация: README и `docs/architecture.md` честно фиксируют компромиссы.
- Идемпотентность платежей: `requestHash`, запись `userOpHash` до отправки, статусы `created/submitted/confirmed/failed`.
- Подтверждение session key чтением контракта, а не по слову вызывающего.
- AES-256-GCM со случайным IV; API-ключи хранятся как sha256; админ-сравнение timing-safe.
- Контракт сознательно наследует референсный SimpleAccount вместо самодельного ERC-4337.
- 61 Solidity-тест уже покрывает основные happy-path и границы; пробелы в основном вокруг self-call/UUPS/гонок.

## План первых безопасных шагов

### Шаг 1 — контрактный hotfix без миграции
**Цель:** закрыть C1 и часть H1.  
**Файлы:** `contracts/src/AgentAccount.sol`, тесты `contracts/test/SessionKeys.t.sol`, `contracts/test/AgentAccount.t.sol`.  
**Изменения:**
- в `_consumeSessionAllowance` запретить `target == address(this)` и `target == address(entryPoint())`;
- переопределить `_authorizeUpgrade` с `require(!frozen)`;
- тесты: self-call registerSessionKey, upgradeToAndCall, withdrawDepositTo, вывод через EntryPoint, апгрейд при frozen.  
**Проверка:** `forge test --root contracts`.  
**Риск отката:** низкий; поведение владельца с полным ключом не меняется.

### Шаг 2 — серверный hotfix платежей
**Цель:** убрать двойную трату при RPC-флапе и гонках.  
**Файлы:** `apps/web/src/lib/payments.ts`, `apps/web/src/lib/chain/relayer.ts`, `apps/web/src/app/api/v1/agents/me/transactions/route.ts`, Prisma/raw migration при необходимости.  
**Изменения:** разделить фазы ошибок; `syncTransactionLogs` best-effort; фильтр событий по `userOpHash`; атомарный in-flight; атомарный захват invoice.  
**Проверка:** сценарные тесты/ручной прогон на anvil: параллельные платежи, падение RPC после отправки, два агента на один invoice.  
**Риск:** средний; меняет только серверную консистентность, не API.

### Шаг 3 — воспроизводимость для нового участника
**Цель:** «у меня не запустится» перестаёт быть нормой.  
**Изменения:** убрать `tsconfig.tsbuildinfo` из git; добавить `.github/workflows` с `pnpm install`, `pnpm build`, `forge test`; README явно про `git submodule update --init --recursive`; скрипт `scripts/check-env.mjs`; решить судьбу `docs/index.html`/`demo/synth-wallet-demo.html` как generated artifacts.  
**Проверка:** чистый клон → команды из README проходят.

## Предлагаемый первый PR-подобный пакет

Я бы начал с **Шага 1**, потому что он маленький и закрывает самый опасный путь. После твоего подтверждения могу внести его в `/mnt/agents/output/www-repo`, прогнать доступные статические проверки и отдать:
- patch/diff одним файлом;
- список новых тестов;
- текст коммита/PR на русском;
- команды для применения у тебя локально (`git apply`, `forge test`, push).