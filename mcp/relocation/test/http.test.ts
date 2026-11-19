import type { webcrypto } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { debugHeaderAuth, jwtAuth, viewingArgsHash } from "@reloc/shared";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../src/context.ts";
import { createRelocationApp } from "../src/http.ts";
import { requestViewing } from "../src/request-viewing.ts";
import { NOW, freshWorld } from "./helpers.ts";

/** HTTP-вхід (Streamable HTTP, stateless). Порт не відкриваємо: транспорт SDK шле запити в app.request. */
function setup(headers: Record<string, string>) {
  const { store, ctx } = freshWorld();
  const audit: AuditEvent[] = [];
  const app = createRelocationApp({ store, now: () => NOW, audit: (e) => audit.push(e) }, { mcp: debugHeaderAuth, human: debugHeaderAuth });
  const transport = new StreamableHTTPClientTransport(new URL("http://relocation.test/mcp"), {
    fetch: async (url, init) => app.request(url, init),
    requestInit: { headers },
  });
  return { app, transport, audit, store, ctx };
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
    expect(await res.json()).toEqual({ ok: true, searches: 2, outbox: 0 });
  });
});

/**
 * POST /approvals/:id/confirm — підтвердження перегляду ЛЮДИНОЮ. Навмисно не MCP-інструмент:
 * агент його не бачить у tools/list. Викликає runtime (CLI) від імені користувача, без `act`.
 */
describe("POST /approvals/:id/confirm", () => {
  const SLOTS = ["2026-11-22T15:00:00.000Z"];

  function pending() {
    const w = setup({});
    w.store.addShortlistItems("s-olena", [{ listingKey: "olx:1001" }]);
    w.store.setStatus("s-olena", "shortlist_ready");
    const req = requestViewing(w.ctx("olena", "agent:concierge@7"), "s-olena", "olx:1001", SLOTS);
    const shownHash = viewingArgsHash({ searchId: "s-olena", listingKey: "olx:1001", slots: SLOTS });
    const confirm = (headers: Record<string, string>, body: unknown) =>
      w.app.request(`/approvals/${req.approvalId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    return { ...w, req, shownHash, confirm };
  }

  it("Олена з хешем того, що бачила → 200 confirmed; пошук → viewing_requested", async () => {
    const { confirm, shownHash, store } = pending();
    const res = await confirm({ "x-debug-sub": "olena" }, { argsHash: shownHash });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "confirmed", listingKey: "olx:1001" });
    expect(store.searchById("s-olena")?.status).toBe("viewing_requested");
  });

  it("з `act` (агент) → 403: підтверджує лише людина", async () => {
    const { confirm, shownHash, store } = pending();
    const res = await confirm({ "x-debug-sub": "olena", "x-debug-act": "agent:concierge@7" }, { argsHash: shownHash });
    expect(res.status).toBe(403);
    expect(store.searchById("s-olena")?.status).toBe("shortlist_ready");
  });

  it("інший хеш → 409 args_mismatch", async () => {
    const { confirm } = pending();
    const res = await confirm({ "x-debug-sub": "olena" }, { argsHash: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "args_mismatch" } });
  });

  it("повторне підтвердження → 409 already_decided", async () => {
    const { confirm, shownHash } = pending();
    await confirm({ "x-debug-sub": "olena" }, { argsHash: shownHash });
    expect((await confirm({ "x-debug-sub": "olena" }, { argsHash: shownHash })).status).toBe(409);
  });

  it("Максим (пошуку не бачить) → 404, як і для неіснуючого запиту", async () => {
    const { confirm, shownHash, app } = pending();
    expect((await confirm({ "x-debug-sub": "maksym" }, { argsHash: shownHash })).status).toBe(404);
    const missing = await app.request("/approvals/appr-999/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-debug-sub": "olena" },
      body: JSON.stringify({ argsHash: shownHash }),
    });
    expect(missing.status).toBe(404);
  });

  it("без principal → 401; без argsHash у тілі → 400", async () => {
    const { confirm, shownHash } = pending();
    expect((await confirm({}, { argsHash: shownHash })).status).toBe(401);
    expect((await confirm({ "x-debug-sub": "olena" }, {})).status).toBe(400);
  });
});

/**
 * Етап 4: JWT-режим. Дві різні довіри:
 *  - /mcp приймає лише делеговані токени від runtime (iss reloc-runtime, aud mcp-relocation);
 *  - /approvals/:id/confirm — лише токени людини від IdP. Токен від runtime тут не діє, навіть з sub=olena
 *    і без act: інакше runtime (або агент, що його зламав) міг би «підтвердити» сам.
 */
const runtime = await generateKeyPair("ES256");
const idp = await generateKeyPair("ES256");
const jwks = async (k: webcrypto.CryptoKeyPair["publicKey"]) => createLocalJWKSet({ keys: [{ ...(await exportJWK(k)), alg: "ES256" }] });
const auth = {
  mcp: jwtAuth({ issuer: "reloc-runtime", audience: "mcp-relocation", keys: await jwks(runtime.publicKey) }),
  human: jwtAuth({ issuer: "http://idp.test/realms/relocation-sandbox", audience: "mcp-relocation", keys: await jwks(idp.publicKey), subjectClaim: "preferred_username" }),
};
const sign = (claims: Record<string, unknown>, key: webcrypto.CryptoKeyPair["privateKey"], iss: string) =>
  new SignJWT(claims).setProtectedHeader({ alg: "ES256" }).setIssuer(iss).setAudience("mcp-relocation").setExpirationTime("5m").sign(key);
const runtimeToken = (claims: Record<string, unknown>) => sign(claims, runtime.privateKey, "reloc-runtime");
const idpToken = (username: string) => sign({ sub: "uuid-123", preferred_username: username }, idp.privateKey, "http://idp.test/realms/relocation-sandbox");

describe("JWT-режим", () => {
  function jwtWorld() {
    const { store, ctx } = freshWorld();
    const audit: AuditEvent[] = [];
    const app = createRelocationApp({ store, now: () => NOW, audit: (e) => audit.push(e) }, auth);
    return { app, store, ctx, audit };
  }

  it("x-debug-sub у JWT-режимі → 401 (заглушка вимкнена)", async () => {
    const res = await jwtWorld().app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", "x-debug-sub": "olena" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("токен людини від IdP на /mcp → 401: агентський вхід приймає лише делеговані токени runtime", async () => {
    const res = await jwtWorld().app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${await idpToken("olena")}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("/mcp з делегованим токеном: аудит отримує людину, агента і run_id", async () => {
    const { app, audit } = jwtWorld();
    const t = await runtimeToken({ sub: "ivan", act: { sub: "agent:concierge@7" }, run_id: "run-9" });
    const transport = new StreamableHTTPClientTransport(new URL("http://relocation.test/mcp"), {
      fetch: async (url, init) => app.request(url, init),
      requestInit: { headers: { authorization: `Bearer ${t}` } },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    await client.callTool({ name: "get_search", arguments: { employee_id: "olena" } });
    await client.close();
    expect(audit).toEqual([expect.objectContaining({ actor: "ivan", agent: "agent:concierge@7", runId: "run-9", decision: "allow_partial" })]);
  });

  describe("підтвердження перегляду", () => {
    const SLOTS = ["2026-11-22T15:00:00.000Z"];
    function pendingJwt() {
      const w = jwtWorld();
      w.store.addShortlistItems("s-olena", [{ listingKey: "olx:1001" }]);
      w.store.setStatus("s-olena", "shortlist_ready");
      const req = requestViewing(w.ctx("olena", "agent:concierge@7"), "s-olena", "olx:1001", SLOTS);
      const confirm = (token: string) =>
        w.app.request(`/approvals/${req.approvalId}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ argsHash: viewingArgsHash({ searchId: "s-olena", listingKey: "olx:1001", slots: SLOTS }) }),
        });
      return { ...w, confirm };
    }

    it("токен Олени від IdP → 200, пошук → viewing_requested", async () => {
      const { confirm, store } = pendingJwt();
      expect((await confirm(await idpToken("olena"))).status).toBe(200);
      expect(store.searchById("s-olena")?.status).toBe("viewing_requested");
    });

    it("токен від runtime з sub=olena і БЕЗ act → 401: runtime не може підтвердити замість людини", async () => {
      const { confirm, store } = pendingJwt();
      expect((await confirm(await runtimeToken({ sub: "olena" }))).status).toBe(401);
      expect(store.searchById("s-olena")?.status).toBe("shortlist_ready");
    });

    it("токен Максима від IdP → 404 (запиту для нього не існує)", async () => {
      const { confirm } = pendingJwt();
      expect((await confirm(await idpToken("maksym"))).status).toBe(404);
    });
  });
});
