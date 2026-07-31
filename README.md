# Synth Wallet

Прототип кошелька для ИИ-агентов на ERC-4337. Агент владеет кошельком, сам принимает
решение о трате и выполняет её одним HTTP-запросом — без человека в цикле и без проверок
личности. Всё работает на тестовой сети: реальных денег в системе нет.

## Что уже работает

- **Два сценария владения** на одной контрактной логике: Human Custodian (человек создаёт
  кошелёк агенту и задаёт границы) и Autonomous Entity (кошелёк принадлежит агенту).
- **Правила трат в контракте**: лимит суммы за окно времени и whitelist получателей.
  Их исполняет блокчейн, а не бэкенд, — обойти через API невозможно.
- **Публичный лог**: каждая исходящая трата пишется событием `AgentTransaction`
  (кто, куда, сколько, когда) и попадает в открытую ленту.
- **Обратимая заморозка** кошелька администратором на случай мошенничества или бага.
- **API для агента**: регистрация, депозит, оплата, история, правила.
- **Интерфейс**: лендинг-манифест, флоу регистрации, дашборд, история, редактор правил,
  публичная витрина агентов с живой лентой.

## Посмотреть без установки

Интерфейс можно открыть в браузере, в том числе с телефона:
**https://claude.ai/code/artifact/e6987484-56e6-4e29-9100-e50859e06389**

Это сборка `demo/` — одна самодостаточная HTML-страница со всеми экранами и кликабельным
флоу: регистрация выдаёт кошелёк и API-ключ, пополнение и платежи меняют баланс, лимит и
whitelist реально отклоняют трату, заморозка блокирует расходы.

Чего в демо нет: блокчейна, бэкенда и базы. Состояние живёт в памяти вкладки и сбрасывается
при перезагрузке, адреса и хеши транзакций сгенерированы на месте. Это витрина дизайна и
логики, а не работающий кошелёк — за настоящим сценарием идите в раздел «Запуск» ниже.

Стили демо — не копия «на глаз»: `demo/build.mjs` берёт скомпилированный бандл Tailwind из
продакшн-сборки приложения, а классы примитивов и иконки в `demo/design-tokens.json` сняты
с работающего интерфейса. Проверки трат в `demo/app.js` повторяют `SpendingRules.consume`
и `AgentAccount._authorizeSpend`, тексты отказов — `apps/web/src/lib/chain/errors.ts`.

Пересобрать после изменений в приложении:

```bash
pnpm --filter web build     # нужен .next с бандлом стилей
node demo/build.mjs
```

## Архитектура

```
contracts/                Foundry, Solidity 0.8.28
  src/AgentAccount.sol           расширение SimpleAccount: режимы, правила, лог, заморозка
  src/AgentAccountFactory.sol    CREATE2-фабрика (по образцу SimpleAccountFactory)
  src/AgentRegistry.sol          регистрация агентов, админ-заморозка, данные витрины
  src/lib/SpendingRules.sol      лимит трат за окно времени
  src/lib/AgentTypes.sol         режимы владения
  test/                          37 тестов, включая полный путь UserOperation
  script/Deploy.s.sol            деплой стенда, пишет deployments/<chainId>.json

apps/web/                 Next.js 16, Tailwind v4, shadcn/ui, viem, Prisma/SQLite
  src/app/(marketing)/           лендинг, регистрация, витрина
  src/app/(app)/                 дашборд, транзакции, правила
  src/app/api/v1/                API агента
  src/lib/chain/                 UserOperation, бандлер, индексатор событий
  src/lib/agents.ts              сервисный слой

examples/agent-demo.ts    сквозной сценарий глазами агента
scripts/export-abi.mjs    перенос ABI из contracts/out в веб-приложение
```

### Контракт

`AgentAccount` — это **расширение** канонического `SimpleAccount` из
[eth-infinitism/account-abstraction](https://github.com/eth-infinitism/account-abstraction)
v0.9.0, а не своя реализация ERC-4337. Из референса без изменений берутся валидация
подписи, работа с EntryPoint, депозит на газ и UUPS-апгрейд. Сверху добавлено четыре вещи:

| Что | Как |
|---|---|
| Режим владения | `custodian == address(0)` → Autonomous Entity |
| Правила трат | `execute`/`executeBatch` вызывают `_authorizeSpend` до перевода |
| Публичный лог | событие `AgentTransaction` после каждой успешной траты |
| Заморозка | `frozen` проверяется и в `_validateSignature`, и в `_authorizeSpend` |

Проверка заморозки на фазе валидации читает только собственный storage аккаунта, поэтому
не нарушает ERC-7562 и корректно отбраковывается настоящим бандлером. Лимиты проверяются
на фазе исполнения: без `block.timestamp` окно расходов не построить.

## Запуск

Нужны Node 20+, pnpm и [Foundry](https://getfoundry.sh).

```bash
pnpm install
cp .env.example apps/web/.env.local     # при необходимости поправьте значения

# 1. Локальная сеть
anvil

# 2. Контракты (в другом терминале)
forge test --root contracts                                  # 37 тестов
PRIVATE_KEY=0xac09…ff80 pnpm deploy:local                    # ключ из .env.example
node scripts/export-abi.mjs

# 3. Приложение
pnpm --filter web exec prisma db push
pnpm dev                                                     # http://localhost:3000

# 4. Демонстрация: агент регистрируется, пополняется и платит сам
pnpm demo
```

Для деплоя в Base Sepolia или Arbitrum Sepolia задайте `BASE_SEPOLIA_RPC_URL`
(или `ARBITRUM_SEPOLIA_RPC_URL`), `PRIVATE_KEY` с тестовыми средствами и выполните
`forge script script/Deploy.s.sol:Deploy --root contracts --rpc-url base_sepolia --broadcast`.
Скрипт использует канонический EntryPoint v0.9 (`0x4337…D009`), уже задеплоенный в этих сетях.
После этого поставьте `NEXT_PUBLIC_CHAIN_ID`, `RPC_URL` и, если есть, `BUNDLER_URL`
(Pimlico/Alchemy) — код кошелька и API при переключении на настоящий бандлер не меняется.

## API

Аутентификация — заголовок `X-API-Key` с ключом, выданным при регистрации.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/v1/agents` | регистрация; ключ показывается один раз |
| GET | `/api/v1/agents/me` | баланс, режим, правила, статус заморозки |
| POST | `/api/v1/agents/me/transactions` | **агент инициирует оплату** |
| GET | `/api/v1/agents/me/transactions` | история из публичного лога |
| POST | `/api/v1/agents/me/deposit` | пополнение из тестового крана |
| PUT | `/api/v1/agents/me/rules` | кастодиан меняет лимит и режим whitelist |
| POST | `/api/v1/agents/me/rules` | добавить/убрать адрес в whitelist |
| GET | `/api/v1/feed` | публичная анонимизированная лента |
| POST | `/api/v1/admin/freeze` | обратимая заморозка (админ-токен) |

```bash
curl -X POST http://localhost:3000/api/v1/agents/me/transactions \
  -H "X-API-Key: sk_agent_…" \
  -H "content-type: application/json" \
  -d '{"to": "0x7099…79C8", "valueEth": "0.05"}'
```

## Прототипные упрощения — для специалистов по безопасности

Ниже — сознательные компромиссы MVP. Каждый из них помечен комментарием в коде.

1. **Приватные ключи агентов хранит сервер**, зашифрованными AES-256-GCM на
   `APP_ENCRYPTION_KEY` из окружения (`src/lib/crypto.ts`). Сделано ради того, чтобы агент
   мог платить одним HTTP-запросом. В проде ключи должны жить в KMS/HSM или у самого
   агента, а сервер — лишь собирать UserOperation и отдавать его на подпись.
2. **Ключ кастодиана тоже серверный**, потому что подключения внешнего кошелька в MVP нет.
   Платформа выдаёт этому ключу небольшой запас газа (`ensureGasAllowance`). В проде
   кастодиан подписывает изменения правил из браузера.
3. **API-ключ — единственный фактор доступа**: без срока жизни, ротации, ограничения
   частоты запросов и списка IP. Хранится как sha256-хеш, сравнение за постоянное время.
4. **Фабрика разрешает прямой вызов `createAccount` реестру**, тогда как референс v0.9
   допускает только `senderCreator`. Нужно для регистрации по HTTP до появления газа у
   агента; отклонение помечено в `AgentAccountFactory.sol`.
5. **Депозит через кран** (`/deposit`) существует только для демонстрации на тестовой сети.
   Контракт принимает ETH обычным переводом, никакого API для этого не требуется.
6. **Админ-заморозка централизована** одним адресом-владельцем реестра. Мультисиг,
   таймлок и логирование причин — за рамками MVP.
7. **Индексатор — доверенный кэш**: SQLite-таблица `TransactionLog` наполняется из событий
   контракта. При расхождении источник истины — блокчейн, достаточно очистить кэш.
8. **Paymaster не реализован**: кошелёк платит за газ своим депозитом в EntryPoint.
   Архитектура к нему готова — добавляется как расширение, без изменения аккаунта.

Вне скоупа MVP по ТЗ и потому не реализовано: AML-проверки и фрод-скрининг, сложная
система ролей, работа с мейннетом и реальными средствами.

## Референсы и лицензии

Проект намеренно строится поверх существующих решений, а не с нуля:

- [eth-infinitism/account-abstraction](https://github.com/eth-infinitism/account-abstraction)
  v0.9.0 (MIT) — EntryPoint, `SimpleAccount`, `SimpleAccountFactory`.
- [abderrahimghazali/shadcn-fintech](https://github.com/abderrahimghazali/shadcn-fintech)
  (MIT) — дизайн-токены, layout дашборда и shadcn/ui-примитивы.
- [shadcnspace/crypgo-shadcn-ui-landingpage](https://github.com/shadcnspace/crypgo-shadcn-ui-landingpage)
  (MIT) — композиция секций лендинга.

Код прототипа распространяется под MIT.

### Публичная ссылка через GitHub Pages

Сборка демо лежит ещё и в `docs/index.html` — это точка входа для GitHub Pages.
Чтобы получить постоянный публичный адрес, который открывается без входа в аккаунт:

1. Repository → Settings → Pages
2. Source: **Deploy from a branch**
3. Branch: `claude/synth-wallet-prototype-ox1cd0`, папка **`/docs`** → Save

Через минуту демо будет доступно по `https://gorkasok2000-beep.github.io/www/`.

Оговорка: GitHub Pages для приватных репозиториев доступны только на платных планах.
На бесплатном плане нужно сначала сделать репозиторий публичным
(Settings → General → Change repository visibility).
