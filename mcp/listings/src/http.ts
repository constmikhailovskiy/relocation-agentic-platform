import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
// Заглушка автентифікації спільна для обох серверів: packages/shared/src/auth-stub.ts.
import { principalFromHeaders } from "@reloc/shared";
import { type ListingsDeps, createListingsServer } from "./mcp.ts";

/**
 * Hono-застосунок сервера listings.
 * Stateless: на кожен POST — новий McpServer і новий транспорт. Сесій немає, тож
 * сервер можна масштабувати горизонтально, а principal не «прилипає» між запитами.
 */
export function createListingsApp(deps: ListingsDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, listings: deps.catalog.listings.length, skipped: deps.catalog.skipped.length }));

  app.post("/mcp", async (c) => {
    const principal = principalFromHeaders(c.req.raw.headers);
    if (principal === undefined) return c.json({ error: "unauthorized", message: "Потрібен principal (етап 2: заголовок x-debug-sub)" }, 401);

    const server = createListingsServer(deps, principal);
    // Без sessionIdGenerator → stateless. enableJsonResponse: відповідь звичайним JSON, а не SSE-потоком —
    // інструменти тут короткі, стрімити нічого.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  // GET (окремий SSE-потік від сервера) і DELETE (кінець сесії) мають сенс лише зі станом.
  app.on(["GET", "DELETE"], "/mcp", (c) => c.json({ error: "method_not_allowed" }, 405));

  return app;
}
