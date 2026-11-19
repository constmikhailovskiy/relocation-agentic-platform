# Relocation Concierge — навчальна агентна платформа

Власник репо готується до технічної співбесіди на Agent Platform Engineer.
Мета проєкту — **зрозуміти кожну цеглинку**, а не просто отримати робочий код.
Специфікація кейсу: `docs/case.md`. Шпаргалка до співбесіди: `docs/interview-answers.md`.

## Як зі мною працювати (режим навчання)

- Пиши українською, простими словами. Досвіду TypeScript «без вайбкодингу» в мене небагато:
  пояснюй синтаксис TS, коли він з'являється вперше (spread, звуження типів, generics, `as`, `?.`, `??`).
- Режим «A»: ти пишеш основу етапу і пояснюєш, я роблю невеликі вправи. Якщо прошу — розв'язуєш вправи сам, з поясненням.
- Спершу тест, що падає, потім код. Показуй, що тест справді червоний до виправлення.
- У поясненнях посилайся на `файл:рядок`. Порядок пояснення: що хочемо (тест) → як зроблено → де викликається → як переконатися самому.
- Пояснюй і **чому** рішення таке: класифікація помилок, безпека, вартість. Додавай «що сказати на співбесіді».
- Кожен етап документуй у `docs/stages/NN-назва.md` (що, навіщо, що спитають, вправи) і `NN-назва-solutions.md` для розв'язків.
- Не роби великих змін без пояснення. Комітити лише коли я прошу; один етап — один логічний коміт.

## Команди

```bash
pnpm install
pnpm typecheck          # tsc, без збірки (noEmit)
pnpm test               # vitest; усі тести працюють без мережі й ключів
pnpm fixtures           # перегенерувати фікстури (детерміновано, git diff має бути порожнім)
pnpm gateway            # LLM gateway на :8787 (потрібен .env: cp .env.example .env)
pnpm gateway:dev        # те саме з перезапуском при змінах
pnpm gateway:key <name> # новий ключ клієнта gateway (у конфіг іде лише sha256)
pnpm cache-demo         # демо prompt caching через gateway
pnpm listings           # MCP-сервер listings на 127.0.0.1:8788/mcp (JWT від runtime; AUTH_MODE=debug — заглушка x-debug-*)
pnpm relocation         # MCP-сервер relocation на 127.0.0.1:8789/mcp (те саме; /approvals — лише токени Keycloak)
pnpm chat --as olena    # CLI-чат з агентом Concierge (потрібні gateway, listings, relocation, Keycloak; --model mock — без звернень до Anthropic)
pnpm sts:keygen         # ключі runtime-STS у .secrets/ (один раз; у git не йдуть)
pnpm worker             # Temporal-воркер (searchWorkflow + Scout); потрібен Temporal: docker compose … up -d temporal
pnpm wf start --as olena --search s-olena --tick "2 minutes" --max 3   # грант + старт workflow (не `pnpm search` — це вбудована команда pnpm)
pnpm test:temporal      # тест «вбитий воркер» на dev-сервері Temporal (не входить у pnpm test)
pnpm evals              # eval-кейси зі справжньою моделлю (ANTHROPIC_API_KEY), ≈ $0.075 повний прогін
pnpm evals:gate         # порівняти evals/reports/report.json з evals/baseline.json (код 1 — блок)
pnpm audit:verify       # перевірити хеш-ланцюжок data/audit.db; --run <id> — події одного запуску
docker compose -f infra/docker-compose.yml up -d keycloak   # Keycloak на 127.0.0.1:8080, realm relocation-sandbox
```

## Середовище

- Node **22.13+** (потрібен вбудований `node:sqlite`); `nvm alias default 22`. pnpm 12 через corepack.
- `.env` — у `.gitignore`, ніколи не комітити й не виводити ключі в термінал.
- `ANTHROPIC_API_KEY` у `.env` — з окремого workspace з лімітом $20. Це бюджет **застосунку**,
  а не Claude Code.

## Ухвалені рішення (не змінювати без обговорення)

- Провайдер: Anthropic — `haiku` = `claude-haiku-5-5` (основна, $0.10/$0.50 за 1M), `sonnet` = `claude-sonnet-5-5` (judge, складні кейси).
- Локальні моделі через Ollama: `gpt-oss:20b` (основна), `mistral-small3.2` (порівняння). MacBook M3, 36 ГБ.
- **Китайські моделі заборонені** — це політика платформи: `ALLOWED_MODEL_ORIGINS` + поле `origin` у реєстрі.
- База: SQLite через `node:sqlite` (без нативних залежностей).
- Бюджети gateway: $5/добу, $0.20 на запуск, промпт ≤ 100K токенів (поріг ціни Haiku 5.5).
- OLX/ЛУН — лише фікстури (публічного API пошуку немає, скрейпінг — ризик ToS). Адаптери за спільним інтерфейсом.
- zod 4 — єдине джерело правди: валідація + типи + JSON Schema для моделі. TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Тести без мережі: `mock`-провайдер у gateway, фікстури з пастками (`fixtures/traps.json`).

## Структура

```
packages/shared/   спільні контракти: zod-схеми, статуси, довідник Львова, AgentSpec, authorize (policy.ts), auth-заглушка
apps/gateway/      LLM gateway (Hono): реєстр моделей, політики, PII, бюджети, ретраї, breaker, fallback, стрім
mcp/listings/      MCP-сервер listings: адаптери OLX/ЛУН, дедуп, пошук, MCP-обгортка (SDK + Hono, stateless)
mcp/relocation/    MCP-сервер relocation: 7 інструментів, права (RBAC/ReBAC/поля), HITL з args_hash, approvals, стор у пам'яті;
                   не-MCP маршрут POST /approvals/:id/confirm (підтвердження людиною)
apps/worker/       Temporal: searchWorkflow, activities Scout, воркер, CLI wf, гранти (data/grants.json)
apps/runtime/      цикл агента, MCP-клієнт з allowlist, HITL-guard, клієнт gateway, CLI-чат
agents/            специфікації агентів (concierge.yaml, scout.yaml; формат AgentSpec)
scripts/           генератор фікстур, gateway-key, cache-demo
fixtures/          згенеровані дані OLX/ЛУН, люди, пошуки, traps.json
docs/              case.md, interview-answers.md, stages/
```

infra/             docker-compose (Keycloak, Temporal), realm relocation-sandbox
evals/             37 eval-кейсів (YAML; fixtures/subtle.olx.json — пастки лише для evals), ранер, перевірки, judge, гейт; baseline.json — з main
.github/workflows/ ci.yml: офлайн-тести + evals-гейт на PR

## Статус

| Етап | Стан |
| --- | --- |
| 0 — монорепо, схеми, фікстури | готово |
| 1 — LLM gateway | готово; вправи 1–4 розв'язані; перевірка версії Node на старті |
| 1, вправа 5 — Ollama | офлайн-частина готова; жива частина відкладена (потрібні Ollama й інтернет) |
| 2 — MCP-сервери listings і relocation | **код готовий**: обидва сервери з усіма інструментами; `update_status` відхиляє недозволений перехід. `authorize` з таблицею з матриці ролей зроблено вже тут (у плані — етап 4). За користувачем: перевірка обох у MCP Inspector. Вправи розв'язані (`docs/stages/02-*-solutions.md`); відкрите рішення за користувачем — listings 7 (маскувати телефон в описі ще й у listings) |
| 3 — цикл агента + CLI-чат | **готово**: повний сценарій пройдено офлайн (`scenario.test.ts`) і наживо з `haiku` ($0.006 за сесію). Вправи 1–8 у `docs/stages/03-runtime.md` не розв'язані; інтерактивний TTY-режим ще не перевірено (лише pipe) |
| 4 — SSO, делегування, аудит | **готово**: аудит з хеш-ланцюжком і `audit:verify`; JWT у серверах; runtime як STS; підтвердження лише токеном Keycloak. Наживо з Keycloak і `haiku`: Іван не бачить бюджет, Богдан не запускає Concierge, Олена — повний сценарій. Вправи 1–6 у `docs/stages/04-security.md` не розв'язані |
| 5 — evals + гейт у CI | **код готовий; критерій «послаблений untrustedText → PR заблоковано» НЕ виконується** — ні на грубих, ні на 6 тонких eval-only пастках (18/18 в обох варіантах) (haiku + серверні шари стійкі). Гейт ловить послаблення інших інструкцій (v7 без check_availability → блок) і регресію коду захисту (без проєкції полів → блок). Workflow ще не запускався. Рішення за користувачем (вправи 1–2). Потрібні: секрет `ANTHROPIC_API_KEY` у GitHub, push, demo-PR. Judge не відкалібровано |
| 6 — Temporal | **готово**: критерій «вбитий воркер — ні втрати, ні дубля» доведено офлайн, на тестовому сервері Temporal (SIGKILL дочірнього воркера) і наживо з haiku (attempt=2 після heartbeat timeout, лист один). Вправи 2–5 за користувачем; статус у IdP не перевіряється |
| 7–9 | за планом у `docs/case.md`, розділ «План» |

## Наступний крок: вправа 5, жива частина (локальна модель)

Офлайн-частина зроблена: `apps/gateway/test/ollama.test.ts` (фальшивий `fetch`), стрім тепер передає
`delta.reasoning` від Ollama до клієнта (`types.ts`, `openai-compatible.ts`, `app.ts`). Деталі — у
`docs/stages/01-gateway-solutions.md`, «Вправа 5». Ще не перевірено: що Ollama справді називає поле `reasoning`.
Відкрита міні-вправа: тест «Ollama не запущена → 503» в `ollama.test.ts`.

1. Встановити Ollama (застосунок з ollama.com або `brew install ollama`), переконатися, що працює `ollama list`.
2. `ollama pull gpt-oss:20b`; за бажанням `ollama pull mistral-small3.2`.
3. Прямий запит до Ollama (`localhost:11434/v1/chat/completions`), зокрема зі `stream: true` — звірити назву
   поля міркувань із тестом; потім через gateway з моделлю `gpt-oss`.
4. `x-data-class: restricted` → `gpt-oss` відповідає, `haiku` дає 403 `data_class_violation`.
5. Tool calling через gateway з `gpt-oss`: перевірити, що поле `reasoning` не губиться між кроками
   (схеми повідомлень — `z.looseObject`).
6. `FAIL_PROVIDER=anthropic`: `haiku` → fallback на `gpt-oss`, заголовок `x-gateway-fallback-from`.
7. Задокументувати результати і вимірювання (швидкість, якість tool calling) у `docs/stages/01-gateway-solutions.md`.

## Етап 2 — коротко (деталі в docs/case.md, «Компоненти і контракти»)

- `mcp/listings` (Streamable HTTP): `search_listings`, `get_listing`, `check_availability`. Адаптери OLX/ЛУН → `Listing`,
  дедуплікація між джерелами, нормалізація валюти (`FX_USD_UAH`), опис у полі `untrustedText`, контакти орендодавця моделі не віддаються.
- `mcp/relocation`: `get_search` (проєкція полів за роллю), `set_criteria`, `save_shortlist` (ідемпотентний),
  `update_status` (лише дозволені переходи з `TRANSITIONS`), `request_viewing` (HITL), `request_budget_exception`, `notify_employee`
  (лише власнику пошуку). Схвалення бюджету — **не** інструмент.
- На етапі 2 auth — заглушка, але `principal` уже прокинутий у кожен обробник. Етап 4 підставив JWT (заглушка — лише `AUTH_MODE=debug`).
- Прийняте правило (немає в case.md): статус міняють власник і relocation-менеджер; `hr_approval → secured` — лише менеджер.
- Відмова: хто ресурсу не бачить — `not_found` (без enumeration); хто бачить, але дія не його — `forbidden` з підказкою.
- Підтвердження перегляду (`confirmViewing`) і рішення щодо бюджету (`decideBudgetException`) — функції для runtime/UI, **не** інструменти.
  `confirmViewing` має маршрут `POST /approvals/:id/confirm` (етап 3); `decideBudgetException` — ще ні (дія HR, studio на етапі 8).

## Етап 3 — коротко (деталі в docs/stages/03-runtime.md)

- `apps/runtime`: `runTurn` (цикл), `connectTools` (allowlist зі специфікації), `viewingGuard` (HITL), `gatewayModel`, `createSession`, `chat.ts`.
- Інструменти з високим ризиком — таблиця `HIGH_RISK_TOOLS` у runtime, не в YAML; без guard сесія не стартує.
- HITL: питаємо ДО `request_viewing`; підтверджуємо хешем ПОКАЗАНОГО (`viewingArgsHash` у shared), не хешем з відповіді.
- Ключ ідемпотентності `runId:step:index` — у `_meta`, генерує runtime. Один хід чату = один `runId`.
- Відхилення від case.md: `relocation.update_status` в allowlist Concierge (інакше не дійти до `shortlist_ready`).
- Тести без мережі: сценарна модель (`apps/runtime/test/fakes.ts`) + справжні сервери в пам'яті (`test/world.ts`).
  Gateway-ний `mock` робить лише один виклик на повідомлення — для сценаріїв не годиться.
- Живе демо: однакове «зараз» для всіх (`LISTINGS_NOW`, `RELOCATION_NOW`, `RUNTIME_NOW` = `2026-11-15T09:00:00.000Z`).

## Етап 4 — коротко (деталі в docs/stages/04-security.md)

- Аудит: `AuditLog` у `packages/shared/src/audit.ts`, один файл `data/audit.db` на обидва сервери, `BEGIN IMMEDIATE`, тригери append-only.
- Сервери: `Authenticate` ін'єкцією; `buildServerAuth` — `/mcp` вірить лише ключу runtime, `/approvals` — лише Keycloak.
- Runtime: `userVerifier` (токен IdP → `VerifiedUser` з брендом), `assertAudience`, `createSts`, `delegatedAuthHeaders` — токен на КОЖЕН запит.
- Ролі: Keycloak (для audience в runtime) = довідник людей (для `authorize` на сервері); тест realm-у тримає їх однаковими. Сервер ролям від runtime не вірить.
- Демо-пароль пісочниці Keycloak: `sandbox` (не секрет; лише 127.0.0.1).

## Етап 5 — коротко (деталі в docs/stages/05-evals.md)

- `pnpm test` лишається офлайн; evals зі справжньою моделлю — окрема команда і окремий job у CI.
- Кожен кейс має позитивну перевірку; самоперевірка: агент «Готово.» провалює всі кейси.
- Security-кейси ×3 і 100%; базова лінія в CI — з базової гілки.
- `concierge` v8: `check_availability` перед переглядом; про іншого працівника — `get_search` з його id.

## Етап 6 — коротко (деталі в docs/stages/06-temporal.md)

- Лист Scout надсилає КОД activity з ключем `${runKey}:notify` (runKey = searchId:iteration), не модель.
- «Нове» = різниця зі знімком шортлиста, який окрема activity записала в історію Temporal.
- runKey = `${searchId}:${firstExecutionRunId}:${iteration}` — унікальний на старт, стабільний між ретраями.
- heartbeatTimeout 30 с; tool_failed → retryable, бюджет/кроки/немає гранту → nonRetryable; провал ітерації не вбиває workflow, grant_missing → пауза.
- `pnpm wf status` потребує запущеного воркера (query виконує воркер).
- Scout працює за грантом (`userFromGrant`), не за логіном; `chat.ts` цей шлях не використовує.
- Workflow-файл — лише `@temporalio/workflow` і `import type`; інтервал і таймаути — з input.
- `allowBuilds` у pnpm-workspace: додано `@swc/core` і `protobufjs` (потрібні Temporal SDK).
