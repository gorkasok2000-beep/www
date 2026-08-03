# PR-5: Rate limiting, lockout за перебор ключей, Dependabot (Этап 2 — Web/API)

**Ветка:** `main` → `claude/synth-wallet-prototype-ox1cd0`
**Файлы (13):** `apps/web/src/lib/ratelimit.ts`, `apps/web/src/lib/ratelimit.test.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/auth.ts`, `apps/web/src/lib/env.ts`, `apps/web/package.json`, `.env.example`, `scripts/check-env.mjs`, `scripts/e2e.mjs`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `README.md`, `docs/architecture.md`

## Что закрывает

Пункт Этапа 2 roadmap: «rate limiting, abuse scoring, lockout для admin/API ключей»
(scoring осознанно не входит — см. оговорки) и пункт supply chain: Dependabot.
До этого PR ограничения частоты запросов не было вовсе (README, упрощение 03):
API-ключ и админ-токен перебирались бесконечно, а регистрация — создающая кошелёк
и тратящая газ оператора — дёргалась бесплатно.

### Лимиты частоты (`ratelimit.ts` + обвязка `route()`)

Три полки по цене запроса, все настраиваются из окружения:

| Правило | Ключ | Дефолт |
|---|---|---|
| `POST /api/v1/agents` (регистрация) | IP | 10/час (`RATE_LIMIT_REGISTER_PER_HOUR`) |
| `/api/v1/admin/*` | IP | 30/мин (`RATE_LIMIT_ADMIN_PER_MIN`) |
| остальное API | хеш API-ключа, иначе IP | 300/мин (`RATE_LIMIT_API_PER_MIN`) |

- Скользящее окно; 429 с `Retry-After` и в том же формате ошибки (`{error, requestId}`),
  что у остальных ответов — агент без человека в цикле понимает, когда повторять.
- Отклонённый запрос в окно **не** записывается: иначе атакующий, ушедший за лимит,
  держал бы себя заблокированным вечно.
- Идентичность — первые 16 символов sha256 ключа: сырой ключ не попадает ни в память
  лимитера, ни в логи.
- Применение — в обвязке `route()` до вызова обработчика: единственная точка, через
  которую проходят все API-роуты; страницы и статику лимиты не трогают.

### Lockout за перебор (`auth.ts`)

- Неизвестный API-ключ и неверный админ-токен — одна и та же неудача по IP:
  `AUTH_LOCKOUT_THRESHOLD` (10) неудач в окне `AUTH_LOCKOUT_WINDOW_MIN` (10 мин) →
  блок IP на `AUTH_LOCKOUT_DURATION_MIN` (15 мин), включая запросы с верным ключом.
- Успешная аутентификация счётчик обнуляет — опечатка не копится вечно.
- После окончания блока до следующего нужно снова набрать порог, а не заблокироваться
  от первой же ошибки.

### Конфигурация и выключатель

Все пороги — env с дефолтами (`env.ts`, `.env.example`, `check-env.mjs`).
`RATE_LIMIT_ENABLED=false` выключает всё целиком — только для e2e-стендов, где
скрипту нужно сотни раз дёргать API с одного адреса.

### Supply chain

`.github/dependabot.yml`: еженедельные обновления npm (корень, pnpm) и
github-actions. Сломанное обновление видно в CI до влития.

## Оговорки (записаны в коде, README п. 03 и architecture.md §6)

- Счётчики **in-memory**: не переживают рестарт и не делятся между инстансами — за
  балансировщиком реальный потолок растёт пропорционально их числу. В проде — Redis
  или лимитер на edge; интерфейс модуля подобран под замену реализации без смены
  вызовов.
- `x-forwarded-for` доверен только когда запрос гарантированно прошёл через свой
  прокси; без него лимиты и блокировки обходятся подменой заголовка.
- Abuse scoring (поведенческий) не реализован — считаются только частота и неудачи
  аутентификации.

## Проверки

- `tsc --noEmit` по `apps/web` — чисто (понадобился `prisma generate`: локальный
  клиент отставал от схемы с Webhook, к PR отношения не имеет).
- `pnpm --filter web test` (tsx + node:test) — 7/7: скользящее окно, Retry-After,
  независимость ключей, lockout/сброс, протухание неудач, sweep, мастер-выключатель.
- CI: добавлен шаг юнит-тестов рядом с tsc/сборкой.
- Сквозные проверки по живому API — раздел 14 в `scripts/e2e.mjs`, включается
  `RATE_LIMIT_E2E=1` и идёт последним (lockout блокирует IP стенда до конца прогона;
  сервер поднимается с маленькими лимитами). В этой среде стенда нет — прогон на
  машине владельца:

```bash
RATE_LIMIT_REGISTER_PER_HOUR=3 AUTH_LOCKOUT_THRESHOLD=3 AUTH_LOCKOUT_DURATION_MIN=1 pnpm --filter web start
RATE_LIMIT_E2E=1 RATE_LIMIT_REGISTER_PER_HOUR=3 AUTH_LOCKOUT_THRESHOLD=3 pnpm e2e
```

## Что дальше

Из Этапа 2 (Web/API) остаются: cookie/CSRF-политика дашборда и scopes read/write
для ключей; из контрактного блока — fuzz/invariant-тесты инвариантов (бюджет
session key, freeze, лимиты кастодиана, дубль реестра, вечные ключи) и
storage-layout checks в CI. Дальше — эксплуатационный блок: incident runbooks,
мониторинг, freeze drill.
