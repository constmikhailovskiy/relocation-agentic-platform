import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../src/catalog.ts";
import { createListingsApp } from "../src/http.ts";
import type { Availability } from "../src/lookup.ts";
import type { ListingsDeps, Principal } from "../src/mcp.ts";

/**
 * HTTP-вхід (Streamable HTTP). Порт не відкриваємо: клієнтський транспорт SDK шле запити
 * у `app.request` — той самий Hono-застосунок, що й на справжньому сервері.
 */
const fixtures = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", name), "utf8"));
const traps = fixtures("traps.json") as { now: string; fxUsdUah: number };
const catalog = buildCatalog({ olx: fixtures("listings.olx.json"), lun: fixtures("listings.lun.json") }, { fxUsdUah: traps.fxUsdUah });
const availability = fixtures("availability.json") as Availability;

function setup(headers: Record<string, string>) {
  const seen: Principal[] = [];
  const deps: ListingsDeps = { catalog, availability, now: () => traps.now, audit: (e) => void seen.push(e.principal) };
  const app = createListingsApp(deps);
  const transport = new StreamableHTTPClientTransport(new URL("http://listings.test/mcp"), {
    fetch: async (url, init) => app.request(url, init), // async: SDK чекає саме Promise<Response>
    requestInit: { headers },
  });
  return { app, transport, seen };
}

describe("HTTP /mcp", () => {
  it("MCP-клієнт через HTTP: initialize → tools/list → tools/call", async () => {
    const { transport } = setup({ "x-debug-sub": "olena" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(3);
    const r = await client.callTool({ name: "search_listings", arguments: { criteria: { maxBudgetUah: 20000 } } });
    expect(r.isError).toBeFalsy();
    await client.close();
  });

  it("principal-заглушка з заголовків доходить до обробника", async () => {
    const { transport, seen } = setup({ "x-debug-sub": "olena", "x-debug-act": "agent:concierge@7" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    await client.callTool({ name: "get_listing", arguments: { key: "olx:1" } });
    expect(seen).toEqual([{ sub: "olena", act: { sub: "agent:concierge@7" } }]);
    await client.close();
  });

  it("без principal — 401 ще до MCP: анонімних викликів немає навіть із заглушкою", async () => {
    const { transport } = setup({});
    const client = new Client({ name: "test", version: "0" });
    await expect(client.connect(transport)).rejects.toMatchObject({ code: 401 });
  });

  it("GET /mcp — 405: сервер stateless, окремого потоку повідомлень немає", async () => {
    const { app } = setup({});
    expect((await app.request("/mcp", { method: "GET", headers: { "x-debug-sub": "olena" } })).status).toBe(405);
  });

  it("/health — 200 і скільки оголошень у каталозі", async () => {
    const { app } = setup({});
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, listings: catalog.listings.length, skipped: catalog.skipped.length });
  });
});
