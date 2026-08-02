# Synth Wallet: от демо к реальному продукту — дорожная карта

Исходная точка: публичный прототип `gorkasok2000-beep/www`, ветка `claude/synth-wallet-prototype-ox1cd0`, снимок `27abf8508bf1f835793ee9591ff69d6677085918`. Документ учитывает код-ревью (`/mnt/agents/output/code-review.md`) и независимую критику плана. Это не vision-эссе, а execution roadmap: у каждого этапа есть scope, что не входит, измеримые gate-критерии и риски.

## 0. Неразмываемый принцип

**Контракт сильнее платформы.** Если ограничение можно проверить onchain, оно проверяется onchain. Платформа — SDK/API/релей/наблюдаемость/UX, а не скрытый кастодиан.

Правила, которые действуют на всех этапах:

1. **Нет mainnet с реальными деньгами до внешнего аудита deployable-конфигурации и ограниченного пилота.**
2. **Нет расширения фич, пока не закрыты blocker/high и не приняты явные решения по medium из текущего ревью.**
3. **Нет silent custody.** Если платформа хранит или использует ключ, это режим с именем, лимитами, предупреждением и путём выхода на self-custody/session key/remote signer.
4. **Нет бесконечного крана.** Любые раздачи средств/газа — с kill-switch, лимитами, отдельным учётом и алертами.
5. **Нет ERC-20/stablecoins, пока session key считает только ETH и нет дизайна token budgets, включая `approve`/Permit2.**
6. **Нет multi-chain обещаний, пока не решена cross-chain upgrade coordination.** Одинаковый CREATE2-адрес с разными имплементациями на разных сетях — источник катастрофы.

## 1. Продукт, который строим

Мы продаём не «кошелёк», а **policy-gated economic identity для ИИ-агента**:
- адрес и проверяемая история агента;
- программируемые границы трат;
- session keys вместо передачи главного ключа;
- платежи с идемпотентностью, статусами и webhooks;
- SDK/API для агентов и dashboard для владельца/кастодиана/аудитора.

Первичный пользователь: команды, запускающие агентов — AI-agent frameworks, внутренние автоматизации компаний, crypto-native разработчики. Потребительские «агенты-помощники» — позже, после зрелой модели ключей.

Не продаём на первом этапе: fiat on-ramp, карты, банковские счета, кредитование, сложные DeFi-стратегии, «полностью автономные деньги» без лимитов.

## 2. Решения, которые нужно принять до старта

Эти решения блокируют архитектуру и аудит. Их нельзя откладывать «на потом».

1. **Кастодиальность:** non-custodial-first. `SERVER_KEY` — dev/test only за feature flag. В продуктовых режимах платформа либо не имеет ключа (`REMOTE`), либо имеет только ограниченный session key.
2. **Owner key пользователя:** до MVP выбрать поддерживаемые модели — self-hosted key, MPC/passkey, enterprise KMS. От этого зависит половина custody-модели.
3. **ERC-4337 стек:** одна версия EntryPoint на весь продукт. План миграции аккаунтов при смене версии EntryPoint пишется до Этапа 1.
4. **Bundler/paymaster:** обязательный adapter-интерфейс над API бандлеров/paymaster; никакого прямого vendor lock-in в платёжном пути.
5. **Газ в пилоте:** по умолчанию газ платит клиент через депозит в EntryPoint; paymaster-спонсорство только allowlist или после Этапа 4.
6. **Активы:** ETH-only до отдельного дизайна token budgets.
7. **Апгрейды:** proxy admin не может быть EOA. Либо immutable v1, либо admin = multisig ≥2-of-3 + timelock + публичный анонс апгрейдов. Платформа не апгрейдит чужой аккаунт без согласия владельца.
8. **Invoice-механика:** получает отдельное юридическое заключение до пилота. Счета между контрагентами — самый токсичный комплаенс-элемент даже без custody ключей.
9. **Публичный feed:** private by default. Public showcase — opt-in и не входит в MVP.
10. **Legal/audit queue:** legal memo и букинг аудиторов стартуют в Этапе 0–1, а не после security hardening.

## 3. Матрица владения ключами

До Этапа 2 эта таблица должна быть заполнена в operational runbook. Без неё «no silent custody» — лозунг.

| Ключ | Назначение | Где хранится | Кто инициирует подпись | Ротация | Компрометация: runbook |
|---|---|---|---|---|---|
| Owner key агента | Полные права на кошелёк | У пользователя: self-hosted/MPC/passkey/enterprise KMS | Только владелец/агент | По решению владельца; платформа не может ротировать | Freeze через registry, revoke session keys, migration to new owner если поддержано |
| Session key платформы | Платежи в границах бюджета/срока/targets | KMS/HSM/enclave, non-exportable | Платёжный сервис через IAM-scoped sign | Автоматическая по TTL, не дольше 90 дней | Немедленный revoke onchain, alert владельцу, freeze при подозрении на злоупотребление |
| Server/operator key | Регистрация, релей, админ-действия | KMS, отдельный от session keys | Backend services | Плановая ротация + emergency rotation | Остановить релей, ротировать, проверить выданные средства/газ |
| Proxy admin | Апгрейд имплементации | Multisig ≥2-of-3 + timelock; EOA запрещён | Только governance flow | Через multisig rotation | Timelock delay + публичный анонс; emergency pause guardian вне timelock |
| Paymaster signer | Спонсорство газа | KMS с budget policy | Paymaster service | Ротация по расписанию | Отключить спонсорство, пересчитать расход, блокировать абьюзеров |
| Bundler EOA / local relayer | Отправка handleOps в dev/test | Только test env; в проде внешний бандлер | Relayer service | Для dev — свободно; прод — нет локального EOA | Остановить релей, проверить неотправленные ops |

Требования к KMS: non-exportable keys, IAM-scoped sign, audit trail каждой подписи, rate limit на частоту подписей, алерт на аномалии, DR/backup и проверенная процедура восстановления.

## 4. Этап 0 — Safety hotfixes: сделать прототип неопасным

**Цель:** закрыть пути, при которых концепция ломается.  
**Ресурс:** минимум 2 инженера (contracts + backend) плюс reviewer, не являющийся автором фикса.  
**Горизонт:** 3–6 недель инженерной работы. Внешнее ревью diff — желательно, но его очередь не блокирует внутренний Gate 0; оно входит в Этап 2.

### Scope

Контракты:
- запрет session key вызывать `address(this)` и `entryPoint`;
- запрет апгрейда замороженного аккаунта;
- generation counter для `sessionKeyTargets`;
- запрет дубликатов аккаунта в `AgentRegistry`;
- adversarial tests: self-call эскалация, UUPS/frozen, перевыпуск session key с сужением targets, duplicate registration, инварианты бюджета.

Сервер:
- post-submit ошибки не переводят платёж в `FAILED`; `syncTransactionLogs` — best-effort;
- фильтрация `UserOperationEvent` по `userOpHash`, учёт `receipt.status`;
- атомарность «один in-flight платёж на агента» и захват invoice `OPEN -> PAYING -> PAID/OPEN`;
- TTL для зависших `CREATED` платежей;
- индексатор проверяет `log.address` и известные аккаунты, а не только topic0;
- валидация `valueEth`/ttl/period: отрицательные/NaN — 400, не 500; 500 не отдают сырой `error.message`;
- faucet/gas allowance выключены по умолчанию или жёстко лимитированы;
- серверная половина duplicate registration: детерминированный salt/хранение salt, «ончейн уже есть» = конфликт, а не успех.

DX:
- generated artifacts убраны из git или явно помечены как generated;
- CI: contracts test, web build, lint, env validation;
- `git submodule update --init --recursive` в README и bootstrap script;
- one-command local run: anvil + deploy + export ABI + web.

### Gate 0 → 1

- Новые adversarial-тесты падают на коде до фикса и зелёные после.
- Фикс C1/H1 подтверждён ревьюером, не являющимся автором фикса.
- Нет открытых blocker/high; medium либо закрыты, либо имеют accepted risk с owner и сроком.
- `forge test`, web build, lint зелёные в CI на чистом окружении.
- Threat model v0.1 разобран командой; legal memo и аудиторский букинг запущены.

## 5. Этап 1 — Воспроизводимый тестнет-MVP

**Цель:** 5–10 дружественных команд проходят путь без ручной помощи.  
**Горизонт:** 6–10 недель после Gate 0.  
**Важно:** серверные hotfix Этапа 0 и инженерный scope Этапа 1 не параллелим — они трогают одни и те же платёжные файлы.

### Scope

- Один публичный тестнет; никакого multi-chain.
- ETH-only платежи/бюджеты.
- Режимы подписи: `REMOTE` и `SESSION_KEY` как продуктовые, `SERVER_KEY` — dev-only.
- Session keys: выпуск, confirm чтением контракта, revoke, expiry, отображение остатка бюджета.
- Invoices: одноразовая оплата, expiry, webhook о статусе.
- Webhooks: at-least-once delivery, подпись, идемпотентность потребителя.
- Bundler adapter-интерфейс; один основной бандлер, fallback через тот же интерфейс.
- Prisma migrations вместо `db push`; versioned schema.
- Наблюдаемость: request id, payment id, userOpHash, agent id, txHash во всех логах.
- Confirmation-depth policy: сколько подтверждений/finality ждать до `confirmed` на L2.

### Gate 1 → 2

- 5 внешних команд прошли end-to-end без ручного вмешательства.
- p95 от POST платежа до `confirmed` ≤ 60 секунд на целевом тестнете; отклонения объяснены.
- 0 необъяснённых платежей в `SUBMITTED` старше 30 минут за последние 14 дней.
- Индексатор rebuildable: кэш пересобирается с нуля из chain; orphaned events после реорга возвращают платёж в `SUBMITTED`, а не оставляют ложный `CONFIRMED`.
- Юридическое memo получено и не требует переделки архитектуры. Если требует — стоп до изменений.
- Код v1 заморожен для аудита; v2 дизайн не начинается до решения по аудиту.

## 6. Этап 2 — Security hardening: допуск к реальным деньгам

**Цель:** продукт допустим к ограниченным реальным средствам.  
**Горизонт:** 4–8 месяцев; зависит от очереди аудиторов и remediation. Не планировать пилот по оптимистичной дате аудита.

### Scope

Контракты:
- минимум один полный внешний аудит deployable-конфигурации: версия EntryPoint, factory params, owner/multisig setup, deploy scripts;
- желательно второй взгляд: ERC-4337/AA-специфичный review;
- fuzz/invariant tests для инвариантов: бюджет session key, freeze, кастодианские лимиты, duplicate registry, no eternal keys;
- один выбранный метод формальной/полуформальной проверки критических инвариантов — не «Certora/Halmos/что-нибудь», а конкретный артефакт с владельцем и сроком;
- storage-layout checks и upgrade validations в CI.

Ключи/подпись:
- заполненная матрица владения ключами из раздела 3;
- KMS/HSM требования внедрены, а не описаны;
- remote signer protocol: replay protection, domain separation, ротация эндпоинтов, SSRF hardening, mTLS/OAuth для enterprise.

Web/API:
- rate limiting, abuse scoring, lockout для admin/API ключей;
- SSRF: DNS resolve до fetch, блок приватных/loopback/link-local, `redirect: manual`, allowlist для enterprise;
- cookie/CSRF policy для dashboard; `secure` cookie в проде; scopes для read/write ключей;
- supply chain: lockfile integrity, Renovate/Dependabot, provenance для критичных зависимостей.

Эксплуатация:
- incident runbooks: freeze, компрометация ключа, stuck bundler, реорг, двойная трата, утечка БД;
- мониторинг: bundler errors, EntryPoint events, reconcile lag, indexer lag, balance drift, failed validation spikes, расход оператора;
- freeze drill ≤ 15 минут, проведён дважды разными людьми;
- game-day с искусственной компрометацией session key.

### Gate 2 → 3

- Нет открытых critical/high после аудита и remediation.
- Medium: либо фикс, либо accepted risk с owner и сроком; accepted risk не может касаться прямого пути траты.
- Freeze drill ≤ 15 минут подтверждён дважды.
- Лимиты по умолчанию: per-agent daily cap, per-tx cap, platform-wide pilot cap.
- Legal sign-off по custody/AML/sanctions для пилота; denylist-screening контрагентов на уровне релеера включён.

## 7. Этап 3 — Ограниченный пилот с реальными деньгами

**Цель:** проверить безопасность и ценность на маленьких потоках.  
**Горизонт:** 6–10 недель.

### Правила пилота

- Только allowlisted клиенты, 5–20 агентов.
- Жёсткие caps по эквиваленту; точные цифры — после финансового и юридического review.
- Одна сеть, один актив. Газ платит клиент через депозит EntryPoint, если иное не одобрено отдельно.
- Глобальный pause, per-agent freeze, per-key revoke — доступны дежурной команде.
- Ежедневная сверка: БД vs chain, payments vs EntryPoint events, invoices vs payments, indexer vs logs.
- Никаких маркетинговых обещаний «полностью автономных денег». Формулировка: policy-gated spending with auditable limits.

### Метрики

- Activation: доля команд, дошедших от SDK до первого confirmed payment.
- Reliability: success rate UserOp; failed by policy vs failed by infra; reconcile latency.
- Safety: число отклонённых контрактом трат; попытки обхода; ложные срабатывания лимитов.
- UX: где пользователи путают owner/session key/remote signer.
- Economics: стоимость газа на платёж, предсказуемость fees, стоимость спонсорства если включено.

### Gate 3 → 4

- Подтверждено отсутствие двойных трат и выходов за лимит по ежедневной сверке, а не только «о них не сообщали».
- Пилот либо пережил реальный инцидент по runbook, либо прошёл game-day с искусственной компрометацией ключа.
- Клиенты подтверждают ценность: агент экономит время/деньги или открывает новый сценарий.
- Юридический/комплаенс контур подтверждает следующее масштабирование.

## 8. Этап 4 — Production readiness

**Цель:** открытие шире без индивидуального babysitting.  
**Горизонт:** 3–6 месяцев после пилота.

### Scope

- Multi-chain: 2–3 сети только после решения cross-chain upgrade coordination и единого конфига chain id → EntryPoint/factory/registry/bundler/explorer.
- Assets: ETH → один stablecoin → ограниченный ERC-20 набор только после token budgets дизайна: лимиты в units токена или USD через oracle с явной поверхностью атаки; запрет/whitelist `approve`; учёт Permit2/off-chain permits; парсинг inner-calls для `executeBatch`.
- Policies v2: rate limit по количеству операций, лимиты по селекторам/контрактам, запрет approvals, отдельные правила для DeFi-вызовов.
- Paymaster: спонсорство газа с бюджетами, anti-abuse, учёт стоимости по клиенту.
- Roles: owner, custodian, operator, auditor, read-only analyst; разделение ключей и scopes.
- Enterprise: SSO/SAML для операторов, audit log, data retention, dedicated KMS, allowlisted signer endpoints.
- HA: redundant RPC/bundler, retry policy, idempotent workers, queue для операций, backfill indexer.
- Security operations: bug bounty, continuous audit, dependency monitoring, automated invariant checks против forked mainnet.

### Gate 4

- Продукт переживает потерю одного RPC, одного бандлера и одного инженера без потери средств.
- Delta-аудит всех изменений после v1.
- Финансовая модель: кто платит за газ, где маржа, как paymaster не становится убыточным.
- Legal sign-off для целевых юрисдикций масштабирования.

## 9. После PMF, без коммитмента

Возможные направления: SDK для agent frameworks, marketplace политик, attestation/reputation layer, policy simulation, cross-chain intents. Это не часть текущего roadmap и не должно создавать обещаний клиентам до подтверждённой ценности базового продукта.

## 10. Риск-реестр

| Риск | Почему критичен | Ранний сигнал | Смягчение |
|---|---|---|---|
| Обход session key через self-call | Ломает core promise | Adversarial test падает до фикса | Запрет self/entryPoint targets, инварианты, аудит |
| Owner-upgrade обходит freeze/rules | Заморозка становится театром | Upgrade при frozen проходит | Frozen cannot upgrade; multisig+timelock; opt-in migration |
| Server mislabels confirmed payment | Двойная трата | Chain vs DB расхождение | Post-submit errors не меняют статус; сверка по userOpHash |
| Nonce/invoice races | Двойная трата без злого умысла | Параллельные тесты дают один nonce/два PAID | DB serialization, nonce manager, invoice state machine |
| Индексатор доверяет topic0 | Поддельная история/витрина | Фейковое событие попадает в feed | Проверка `log.address`/known accounts, rebuildable cache |
| SSRF через signerUrl | Доступ во внутреннюю сеть | Запрос к metadata/private range в тесте | DNS resolve, blocklists, redirect manual, allowlists |
| Faucet/operator drain | Прямая финансовая потеря | Рост выдач/расхода оператора | Kill-switch, лимиты, отдельный учёт, alerts |
| ERC-20 вне бюджета | Бюджет не покрывает стоимость | Токены уходят без consume | Token-aware budgets, запрет approve/Permit2 до дизайна |
| EntryPoint version drift | Миграция всех аккаунтов | Bundler/SDK несовместимость | Одна версия стека, план миграции до Этапа 1 |
| Cross-chain upgrade split-brain | Один адрес, разное поведение | Имплементации разошлись по сетям | Multi-chain запрещён до coordination design |
| Комплаенс/custody граница | Регуляторный стоп | Юрист не подтверждает non-custody | Legal memo до код-фриза v1, invoice отдельным заключением |
| Реорг/индексатор расходится | Ложный CONFIRMED | Orphaned UserOperationEvent | Confirmation-depth policy, reorg handling, rebuild indexer |
| Paymaster abuse | Убыточное спонсорство | Cost per customer растёт без транзакций | Budgets, anti-abuse scoring, allowlist ops |
| Proxy admin compromise | Контроль над всеми аккаунтами | EOA-admin в конфиге | Multisig ≥2-of-3 + timelock, публичные анонсы |

## 11. Первые 2 недели execution plan

Неделя 1:
- День 1–2: контрактный hotfix C1 + тесты self-call/UUPS/frozen.
- День 3: generation counter для session targets + duplicate registry guard.
- День 4–5: серверный hotfix B1/H3/H4/H5: state machine платежей, фильтр по userOpHash, атомарность in-flight/invoice, TTL CREATED.

Неделя 2:
- День 1: индексатор `log.address`/known accounts + валидация ввода/санитизация 500.
- День 2: CI, generated artifacts, bootstrap script, submodule docs.
- День 3: threat model v0.1 + матрица владения ключами draft.
- День 4: запуск legal memo и аудиторского букинга; решения по EntryPoint version и upgrade governance.
- День 5: командный security review diff; выпуск «testnet-safe MVP» со списком, что ещё не поддерживается.

Результат двух недель: не продукт, а безопасная база, на которой не стыдно строить пилот.

## Итог

Переход от демо к продукту — три смены состояния:

1. **Демо → безопасный тестнет-MVP:** закрыть пути обхода, сделать запуск воспроизводимым, принять архитектурные решения до аудита.
2. **MVP → доверенная инфраструктура:** аудит deployable-конфигурации, ключи/KMS, мониторинг, incident response, legal boundaries.
3. **Инфраструктура → продукт:** пилот с caps, измеримая ценность, enterprise controls и только потом масштабирование активов/сетей/пользователей.

Любой этап, который ослабляет принцип «контракт сильнее платформы» ради скорости, — не прогресс, а долг перед первым реальным инцидентом.