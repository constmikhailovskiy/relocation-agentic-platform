import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { principalFromHeaders } from "@reloc/shared";
import { Hono } from "hono";
import { type RelocationDeps, createRelocationServer } from "./mcp.ts";

/**
 * Hono-застосунок сервера relocation. Та сама схема, що в listings:
 * stateless — на кожен POST новий McpServer і транспорт, principal не «прилипає» між запитами.
 * Стан (deps.store) при цьому спільний: він створений один раз у loadDeps.
 */
export function createRelocationApp(deps: RelocationDeps): Hono {
  const app = new Hono();

  // Лише кількість: /health зазвичай доступний моніторингу без авторизації, тож жодних даних про людей.
  app.get("/health", (c) => c.json({ ok: true, searches: deps.store.searchCount() }));

  app.post("/mcp", async (c) => {
    const principal = principalFromHeaders(c.req.raw.headers);
    if (principal === undefined) return c.json({ error: "unauthorized", message: "Потрібен principal (етап 2: заголовок x-debug-sub)" }, 401);

    const server = createRelocationServer(deps, principal);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  app.on(["GET", "DELETE"], "/mcp", (c) => c.json({ error: "method_not_allowed" }, 405));

  return app;
}
