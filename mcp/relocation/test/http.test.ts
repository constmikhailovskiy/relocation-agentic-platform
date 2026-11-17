import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../src/context.ts";
import { createRelocationApp } from "../src/http.ts";
import { NOW, freshWorld } from "./helpers.ts";

/** HTTP-вхід (Streamable HTTP, stateless). Порт не відкриваємо: транспорт SDK шле запити в app.request. */
function setup(headers: Record<string, string>) {
  const { store } = freshWorld();
  const audit: AuditEvent[] = [];
  const app = createRelocationApp({ store, now: () => NOW, audit: (e) => audit.push(e) });
  const transport = new StreamableHTTPClientTransport(new URL("http://relocation.test/mcp"), {
    fetch: async (url, init) => app.request(url, init),
    requestInit: { headers },
  });
  return { app, transport, audit };
}

describe("HTTP /mcp", () => {
  it("initialize → tools/list (7) → tools/call; principal із заголовків доходить до аудиту", async () => {
    const { transport, audit } = setup({ "x-debug-sub": "ivan", "x-debug-act": "agent:concierge@7" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(7);
    const r = await client.callTool({ name: "get_search", arguments: { employee_id: "olena" } });
    expect(r.isError).toBeFalsy();
    expect(audit).toEqual([expect.objectContaining({ actor: "ivan", agent: "agent:concierge@7", decision: "allow_partial" })]);
    await client.close();
  });

  it("без principal → 401", async () => {
    const { app } = setup({});
    const res = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("GET /mcp → 405 (stateless: окремого потоку від сервера немає)", async () => {
    expect((await setup({}).app.request("/mcp")).status).toBe(405);
  });

  it("/health — без PII: лише кількості", async () => {
    const res = await setup({}).app.request("/health");
    expect(await res.json()).toEqual({ ok: true, searches: 2 });
  });
});
