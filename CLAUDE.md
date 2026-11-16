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
packages/shared/   спільні контракти: zod-схеми, статуси, довідник Львова, AgentSpec
apps/gateway/      LLM gateway (Hono): реєстр моделей, політики, PII, бюджети, ретраї, breaker, fallback, стрім
scripts/           генератор фікстур, gateway-key, cache-demo
fixtures/          згенеровані дані OLX/ЛУН, люди, пошуки, traps.json
docs/              case.md, interview-answers.md, stages/
```

Майбутні: `mcp/listings`, `mcp/relocation` (етап 2), `apps/runtime` (етап 3), `agents/`, `evals/`, `infra/`.

## Статус

| Етап | Стан |
| --- | --- |
| 0 — монорепо, схеми, фікстури | готово |
| 1 — LLM gateway | готово; вправи 1–4 розв'язані; перевірка версії Node на старті |
| 1, вправа 5 — Ollama | офлайн-частина готова (контрактні тести провайдера, `reasoning` у стрімі); **наступна — жива частина** |
| 2 — MCP-сервери listings і relocation | далі |
| 3–9 | за планом у `docs/case.md`, розділ «План» |

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
- На етапі 2 auth — заглушка, але `principal` уже прокинутий у кожен обробник (етап 4 підставить JWT).
