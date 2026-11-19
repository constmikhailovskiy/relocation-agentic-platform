**Тип:** рутина · **Складність:** проста

Коли інструмент MCP-сервера падає, лог має вигляд `[listings] search_listings: Error ...` — без `runId` і без того,
від чийого імені був виклик. Знайти, який запуск агента зламався, неможливо.

Що зробити:
- В обох серверах (`mcp/listings/src/mcp.ts`, `mcp/relocation/src/mcp.ts`) типовий `logError` пише один рядок JSON:
  `{ level: "error", server, tool, runId, sub, error }`. `runId` і `sub` — з principal виклику, якщо вони є.
- Формат як у gateway (`apps/gateway/src/app.ts`, `console.error(JSON.stringify(...))`).
- Жодних аргументів інструмента в лозі (там можуть бути персональні дані).
- Тести на обидва сервери: лог містить `runId`, `tool` і не містить аргументів.

Готово, коли: охоплено всі місця, де MCP-сервери логують помилки інструментів; `pnpm typecheck` і `pnpm test` зелені.
