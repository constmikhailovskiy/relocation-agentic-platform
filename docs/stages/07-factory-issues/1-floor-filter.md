**Тип:** фіча · **Складність:** проста

Працівники часто не хочуть перший поверх (шум, безпека) і останній (дах, спека). Додай у критерії пошуку
прапорець `notFirstOrLastFloor`.

Що зробити:
- `packages/shared/src/criteria.ts`: поле `notFirstOrLastFloor: z.boolean().default(false)` з `.describe(...)` українською.
- `mcp/listings/src/search.ts`: якщо прапорець увімкнено — відкидати оголошення з `floor === 1` або `floor === totalFloors`.
- Тести в `mcp/listings/test/`: прапорець вимкнено → такі квартири лишаються; увімкнено → зникають; одноповерховий
  будинок (`totalFloors === 1`) теж зникає.

Готово, коли: `pnpm typecheck` і `pnpm test` зелені, схема, фільтр і тести змінені разом.
