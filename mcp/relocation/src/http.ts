import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { principalFromHeaders } from "@reloc/shared";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type Ctx, RelocationError } from "./context.ts";
import { type RelocationDeps, createRelocationServer } from "./mcp.ts";
import { confirmViewing } from "./request-viewing.ts";

/** Коди доменних помилок → HTTP-статуси для не-MCP маршрутів (MCP повертає їх як isError). */
const HTTP_STATUS: Partial<Record<RelocationError["code"], ContentfulStatusCode>> = {
  not_found: 404,
  forbidden: 403,
  invalid_input: 400,
  args_mismatch: 409,
  already_decided: 409,
  wrong_status: 409,
  invalid_transition: 409,
  search_closed: 409,
  expired: 410,
};

const ConfirmBody = z.strictObject({ argsHash: z.string().regex(/^[0-9a-f]{64}$/) });

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

  /**
   * Підтвердження перегляду ЛЮДИНОЮ. Це не MCP-інструмент: агент цей маршрут не бачить і не може викликати
   * через tools/call. Тіло — хеш того, що runtime ПОКАЗАВ користувачу (viewingArgsHash), а не хеш із відповіді сервера.
   * `act` у principal → 403 (перевірка в confirmViewing). Увага: поки auth — заглушка з заголовків, хто завгодно
   * може надіслати x-debug-sub: olena без x-debug-act. Справжній захист — етап 4 (токен самого користувача).
   */
  app.post("/approvals/:id/confirm", async (c) => {
    const principal = principalFromHeaders(c.req.raw.headers);
    if (principal === undefined) return c.json({ error: { code: "unauthorized", message: "Потрібен principal" } }, 401);
    const body = ConfirmBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "invalid_input", message: "Очікуємо {argsHash: sha256 hex}" } }, 400);

    const ctx: Ctx = { store: deps.store, principal, now: deps.now, ...(deps.audit && { audit: deps.audit }) };
    try {
      return c.json(confirmViewing(ctx, c.req.param("id"), body.data.argsHash));
    } catch (e) {
      if (!(e instanceof RelocationError)) throw e;
      return c.json({ error: { code: e.code, message: e.message } }, HTTP_STATUS[e.code] ?? 400);
    }
  });

  app.on(["GET", "DELETE"], "/mcp", (c) => c.json({ error: "method_not_allowed" }, 405));

  return app;
}
