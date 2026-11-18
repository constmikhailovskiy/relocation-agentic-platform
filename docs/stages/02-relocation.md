# Етап 2 — MCP-сервер relocation

`relocation` — внутрішня система: пошуки житла, статуси, шортлисти, запити на схвалення. На відміну
від `listings`, тут є чиї-небудь дані (бюджети, компенсації) і дії із записом, тож головне —
**хто що може**. Права перевіряє сервер на кожен виклик, а не промпт.

Як і в `listings`, серцевина — звичайний TypeScript (доменні функції, по одній на інструмент), а MCP SDK
лише загортає їх (`mcp.ts`). Запуск: `pnpm relocation` → `http://127.0.0.1:8789/mcp`.
Змінні: `RELOCATION_PORT`, `RELOCATION_NOW` (див. `.env.example`).

## Сім інструментів і дві дії, яких агенту не дали

| Інструмент | Що робить | Ключове правило |
| --- | --- | --- |
| `get_search(employee_id)` | пошук працівника | проєкція полів: керівнику — лише `id`, `employeeId`, `status` |
| `set_criteria(employee_id, criteria)` | зберегти критерії | бюджет понад ліміт компанії → `over_cap` з підказкою |
| `save_shortlist(search_id, items)` | додати в шортлист | ідемпотентний за `(search_id, listing_key)` |
| `update_status(search_id, to, reason)` | змінити статус | лише переходи з `TRANSITIONS`; у `secured` — лише relocation-менеджер; причина — в історію статусів |
| `request_viewing(search_id, listing_key, slots)` | попросити перегляд | лише з шортлиста; створює `pending_confirmation` з `args_hash` і терміном 24 год, нічого не надсилає |
| `request_budget_exception(search_id, amount_uah, reason)` | попросити виняток з ліміту | створює `pending`; повтор повертає той самий запит |
| `notify_employee(search_id, message)` | повідомити | адресата в схемі немає — лише власник пошуку |

| Дія людини (НЕ інструмент) | Хто | Бар'єри |
| --- | --- | --- |
| `confirmViewing(approvalId, shownHash)` | сам користувач, що просив | без агента (`act`), хеш = показаному, не вдруге |
| `decideBudgetException(approvalId, decision)` | relocation-менеджер | без агента, лише менеджер, не свій запит (SoD) |

Тест `mcp.test.ts` перевіряє, що `tools/list` повертає рівно сім імен і жодне не схоже на
`approve` / `confirm` / `decide`. Найнадійніший захист — не мати інструмента.

## Шлях одного виклику

```
POST /mcp ──► principalFromHeaders ──► createRelocationServer(deps, principal)   (новий на кожен запит)
                (етап 4: JWT)                 │
                                              ▼
              SDK: strictObject-схема входу (зайве поле → помилка ще тут)
                                              │
                                              ▼
              доменна функція: права → стан → вміст → запис
                 authorizeSearch ─► authorize (packages/shared/src/policy.ts) ─► аудит з рішенням
                                              │
                                              ▼
              deps.store (ОДИН на процес; SQLite замінить лише його)
```

## Файли

| Файл | Що робить |
| --- | --- |
| `packages/shared/src/policy.ts` | `authorize(actor, action, resource)` → `{decision, reason, fields}`: RBAC + ReBAC + рівень полів; `Principal`, `Actor` |
| `packages/shared/src/search.ts` | схеми `Search` і `ShortlistItem` |
| `packages/shared/src/auth-stub.ts` | `principalFromHeaders` — заглушка auth для обох MCP-серверів |
| `packages/shared/src/args-hash.ts` | канонічний JSON + sha256; у shared, бо хеш рахують і сервер, і runtime |
| `mcp/relocation/src/context.ts` | `Ctx`, `RelocationError`, `authorizeSearch`, `canRead`, `assertOpen`, `invalidInput`, `writeAudit` |
| `mcp/relocation/src/store.ts` | сховище в пам'яті: пошуки, історія статусів (з причиною), шортлисти (ідемпотентно), approvals, outbox |
| `mcp/relocation/src/get-search.ts` … `notify-employee.ts` | по файлу на інструмент |
| `mcp/relocation/src/request-viewing.ts` | `requestViewing` (інструмент) і `confirmViewing` (дія людини) |
| `mcp/relocation/src/budget-exception.ts` | `requestBudgetException` (інструмент) і `decideBudgetException` (дія людини) |
| `mcp/relocation/src/mcp.ts` | **MCP-обгортка**: 7 `registerTool`, snake_case-входи → доменні виклики, мапінг помилок |
| `mcp/relocation/src/http.ts`, `config.ts`, `server.ts` | HTTP-вхід (stateless), env, точка входу |
| `mcp/relocation/test/helpers.ts` | `freshWorld()` — свіжий стор із фікстур на тест, `errorOf`, `NOW` |

## Права: одна функція, три моделі доступу

`authorize` — чиста функція (без БД): сервер сам знаходить власника пошуку і його керівника і передає їх.
Тому її тестує таблиця з матриці ролей `case.md` (`policy.test.ts`).

- **RBAC.** Роль `relocation_manager` дає все.
- **Власник.** `actor.sub === ownerId` — і саме тут закрито горизонтальний доступ (IDOR): `sub` береться з
  principal, а не з аргументу моделі. Виняток — `mark_secured`: «схвалено» вирішує HR.
- **ReBAC.** Роль `hiring_manager` нічого не дає без відношення `manager_of`. Тест: Софія — керівник,
  але не Олени → `deny`.
- **Рівень полів.** Рішення повертає `fields`, і `get_search` будує відповідь З цього списку (allowlist).
  Нове поле в пошуку нікому не потрапить, доки його явно не додадуть.
- **`act` не читається.** Агент має рівно права користувача. Звуження до інструментів агента робить
  runtime (`AgentSpec.tools`) — разом це «перетин прав».

### `not_found` чи `forbidden`

- Хто пошуку **не бачить** → `not_found` з тим самим текстом, що й для неіснуючого. Інакше перебором ID
  можна дізнатися, у кого з колег є пошук (enumeration).
- Хто **бачить**, але дія не його (Іван міняє критерії Олени; Олена ставить `secured`) → `forbidden` з
  підказкою, що робити. Приховувати вже нічого, а модель має пояснити користувачу правду.
- Справжня причина (`no_relation`, `manager_read_only`, `requires_relocation_manager`) — завжди в аудиті.

## Порядок у кожному інструменті запису

**права → стан → вміст → запис.** Права першими: інакше Максим за текстом помилки валідації дізнався б,
що пошук Олени існує. Стан (`assertOpen`) — кінцевий статус не змінюється. Вміст — zod; помилку
`invalidInput` перетворює на «шлях: що не так», щоб модель знала, яке поле виправити.

## HITL для перегляду: `args_hash`

1. Агент кличе `request_viewing` → сервер рахує `sha256(канонічний JSON {searchId, listingKey, slots})`
   і зберігає запит `pending_confirmation`. Орендодавцю нічого не йде, статус пошуку не змінюється.
2. Runtime (етап 3) показує користувачу саме ці аргументи і питає «так / ні».
3. «Так» → runtime **сам** рахує `argsHash` з того, що показав (функція в `packages/shared`), і передає в
   `confirmViewing(approvalId, hash)`. Не збігся (агент між показом і підтвердженням підмінив слот) →
   `args_mismatch`. Збігся → `confirmed`, пошук → `viewing_requested` (із записом в історію).

Канонічний JSON (ключі відсортовані, слоти відсортовані) — щоб хеш залежав від змісту, а не від порядку.

**Чесні межі на кінець етапу 2:**
- Захист від підміни працює, лише якщо runtime рахує хеш сам. Якщо він просто поверне `argsHash` з
  відповіді сервера, це порівняння значення з самим собою. У тестах зараз саме так — бо runtime ще немає.
- `confirmViewing` і `decideBudgetException` поки викликаються лише з тестів. Runtime — окремий процес,
  тож етап 3 має додати на цьому сервері окремий (не MCP) маршрут для дій людини — зі своєю автентифікацією.

## Ідемпотентність

- `save_shortlist` — за `(search_id, listing_key)`; повтор відповідає `alreadyPresent`, а не помилкою.
  Перший `reason` виграє. У SQLite: `PRIMARY KEY` + `ON CONFLICT DO NOTHING`.
- `request_viewing` — той самий хеш **від того самого користувача** → той самий запит.
- `request_budget_exception` — поки є свій `pending`, повтор повертає його ж (без спаму в HR).
  Ключ ідемпотентності включає автора: інакше запит Тараса повернувся б Олені, а схвалити його Тарас не
  може (SoD) — запит завис би назавжди. Цей баг знайшов рев'ю, тест на нього є.
- `notify_employee` — за ключем ідемпотентності з `_meta` (його генерує runtime, не модель; вправа 3).

## MCP-обгортка: чим відрізняється від listings

- **`strictObject` на всіх входах.** SDK приймає готову zod-схему, тож зайве поле відкидається ще до
  обробника, а модель бачить `additionalProperties: false`. У listings зайві поля тихо відкидаються.
- **Аудит у домені, не в обгортці.** Подія має містити рішення (`allow_partial`, `deny`), а його знає лише
  `authorize`. Формат збігається з тим, що чекає eval з `case.md`: `{action: relocation.get_search, decision: allow_partial}`.
  Межі (повний аудит — етап 4): `allow` пишеться після перевірки прав, але до перевірок стану й вмісту, тож
  відхилений `invalid_transition` чи `over_cap` виглядає в аудиті як дозволена дія; а виклик, який SDK
  відкинув за схемою (наприклад, `notify_employee` з полем `to`), до домену не доходить і події не має.
- **`outputSchema` у `get_search` з необов'язковими полями.** Клієнт SDK після `tools/list` перевіряє
  `structuredContent` за схемою. Урізана відповідь Івану інакше б не пройшла — тест на це є, і мутація
  (зробити `companyCapUah` обов'язковим) його валить.
- **snake_case у входах** (`employee_id`, `listing_key`) — як у таблиці контрактів `case.md`; виходи —
  доменні типи в camelCase.
- **Стор один на процес.** `McpServer` — новий на запит, а стан — у `deps.store`. Тест: критерії, збережені
  через один екземпляр сервера, бачить інший.

## TypeScript, що з'явився вперше

| Запис | Що означає |
| --- | --- |
| `(typeof SEARCH_FIELDS)[number]` | тип будь-якого елемента масиву; з `as const` — точно `"id" \| "employeeId" \| …` |
| `it.each([...])("$who …", ({ actor }) => …)` | один тест на рядок таблиці; `$who` / `%s` підставляються в назву |
| `private readonly x = new Map()` | поле класу: видно лише всередині, присвоїти можна лише при створенні |
| `static fromSeed(...)` | метод класу, а не екземпляра: `RelocationStore.fromSeed(...)`; конструктор `private` — інакше стор не створити |
| `Partial<Search>` | будь-яка підмножина полів `Search` |
| `{ ...current, ...patch }` | новий об'єкт: поля `patch` перекривають `current`; старий об'єкт не змінюється |
| `Set` / `.has()` | множина без повторів; перевірка наявності |
| `type A = {…} & ({kind:"viewing"…} \| {kind:"budget_exception"…})` | **discriminated union**: після `a.kind === "viewing"` TS знає поля саме цього варіанта |
| `T extends unknown ? Omit<T, K> : never` | **розподільний умовний тип**: `Omit` для кожного варіанта union окремо (звичайний `Omit` «злипає» union) |
| `` `relocation.${string}` `` | **template literal type**: будь-який рядок, що починається з `relocation.` |
| `z.strictObject({...})` | об'єкт, де зайве поле — помилка (у `z.object` — тихо відкидається) |
| `vi.spyOn(store, "m").mockImplementation(...)` | підмінити метод конкретного об'єкта в тесті (тут: імітувати збій БД) |

## Що можуть спитати на співбесіді

- **Де перевіряються права?** У MCP-сервері, на кожен виклик, однією чистою функцією `authorize`. Промпт
  нічого не вирішує: injection не може «переконати» `if`.
- **Як агент не стане адміном?** `act` іде в аудит, але прав не додає; інструменти агента звужує runtime.
- **Як Іван не дізнається бюджет Олени?** Він отримує урізане представлення; бюджету немає навіть у сирому JSON.
- **Чому відмова — «не знайдено»?** Захист від enumeration. Але тим, хто ресурс бачить, — чесне `forbidden`.
- **Як працює HITL?** Агент лише створює запит; людина підтверджує конкретні аргументи; підтвердження
  прив'язане до `args_hash`, який runtime рахує сам з показаного, тому підміна після показу не пройде.
- **Чому схвалення бюджету — не інструмент?** Найнадійніший захист — не давати інструмент. Плюс захист у
  глибину: сама функція відкидає агента, не-менеджерів і власні запити (SoD).
- **Як закрито ексфільтрацію через повідомлення?** Немає поля адресата; `strictObject` відкидає спробу.
- **Що буде при повторі виклику?** Записи ідемпотентні за природним ключем; повтор — та сама відповідь.

## Вправи

Розв'язки з поясненнями: [02-relocation-solutions.md](02-relocation-solutions.md) (усі шість; 1–3 і 6 — у коді, 4–5 — рекомендації).

1. **(міні) Нові критерії виводять з `needs_attention`.** На діаграмі `needs_attention → searching` підписано
   «нові критерії». Напиши тест у `set-criteria.test.ts`: після `set_criteria` пошук у `needs_attention`
   переходить у `searching`. Перехід — через `assertTransition`, а не напряму.
2. **(міні) Термін дії запиту на перегляд.** `pending_confirmation` зараз висить вічно. Додай `expiresAt`
   (наприклад, 24 год від `ctx.now()`) і тест: `confirmViewing` після терміну → нова помилка `expired`.
3. **(етап 6) Ідемпотентний `notify_employee`.** Ретрай activity в Temporal надішле лист двічі. Додай
   необов'язковий `idempotency_key` і тест: два виклики з тим самим ключем → один лист в outbox.
   Питання: хто має генерувати ключ — модель чи runtime? Чому?
4. **(обговоримо) Чи має `save_shortlist` перевіряти, що оголошення існує?** Ключ приходить з `listings`,
   але `relocation` його не перевіряє. Варіанти: довіряти; питати `listings` (зв'язок між сервісами,
   таймаути); перевіряти при `request_viewing` через `check_availability`. Що обереш і чому?
5. **(обговоримо) Optimistic locking.** У `case.md` у таблиці `searches` є `version`. Два одночасні
   `set_criteria` зараз — «останній виграє». Як би ти додав `expected_version` і яку помилку повертав би моделі?
6. **(міні) Мутаційна перевірка самостійно.** У `policy.ts` заміни `actor.sub === resource.ownerId` на
   `true`. Які тести впадуть? Поверни.
