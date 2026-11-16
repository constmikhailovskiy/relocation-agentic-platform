import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { type ListingsDeps, type Principal, createListingsServer } from "./mcp.ts";

/**
 * ЗАГЛУШКА автентифікації (етап 2). Principal береться з заголовків — підробити може будь-хто,
 * тому сервер слухає лише 127.0.0.1. Етап 4 замінить цю функцію перевіркою JWT
 * (підпис, aud=mcp-listings, sub і act з токена), а решта коду не зміниться.
 */
export function principalFromHeaders(headers: Headers): Principal | undefined {
  const sub = headers.get("x-debug-sub");
  if (!sub) return undefined;
  const act = headers.get("x-debug-act");
  return act ? { sub, act: { sub: act } } : { sub };
}

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
