import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Principal } from "@reloc/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../src/context.ts";
import { type RelocationDeps, createRelocationServer } from "../src/mcp.ts";
import type { RelocationStore } from "../src/store.ts";
import { NOW, freshWorld } from "./helpers.ts";

/**
 * MCP-обгортка relocation через справжній клієнт SDK і InMemoryTransport (без мережі).
 * Головне тут — що бачить модель (tools/list) і що проходить крізь клієнт SDK (structuredContent проти outputSchema).
 */
const AGENT = "agent:concierge@7";
const EXPECTED_TOOLS = [
  "get_search",
  "notify_employee",
  "request_budget_exception",
  "request_viewing",
  "save_shortlist",
  "set_criteria",
  "update_status",
];

let store: RelocationStore;
let audit: AuditEvent[];
const clients: Client[] = [];

beforeEach(() => {
  ({ store, audit } = freshWorld());
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(sub: string, extra: Partial<RelocationDeps> = {}) {
  const principal: Principal = { sub, act: { sub: AGENT } };
  const deps: RelocationDeps = { store, now: () => NOW, audit: (e) => audit.push(e), logError: () => {}, ...extra };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createRelocationServer(deps, principal).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  clients.push(client);
  // Як справжній агент: спершу tools/list. Після нього клієнт SDK перевіряє structuredContent за outputSchema.
  await client.listTools();
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { text }; // помилки валідації аргументів SDK пише звичайним текстом
  }
  return { result, text, data: (result.structuredContent ?? parsed) as Record<string, any> };
}

describe("tools/list — поверхня інструментів", () => {
  it("рівно сім інструментів; схвалювати чи підтверджувати агент не може нічим", async () => {
    const { tools } = await (await connect("olena")).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(tools.some((t) => /approve|confirm|decide/.test(t.name))).toBe(false);
  });

  it("notify_employee: у схемі немає адресата, зайві поля заборонені", async () => {
    const { tools } = await (await connect("olena")).listTools();
    const notify = tools.find((t) => t.name === "notify_employee")!;
    expect(Object.keys(notify.inputSchema.properties ?? {}).sort()).toEqual(["message", "search_id"]);
    expect(notify.inputSchema.additionalProperties).toBe(false);
  });

  it("кожен інструмент має опис; get_search позначено як лише читання", async () => {
    const { tools } = await (await connect("olena")).listTools();
    for (const t of tools) expect(t.description, t.name).toBeTruthy();
    expect(tools.find((t) => t.name === "get_search")!.annotations?.readOnlyHint).toBe(true);
  });
});

describe("get_search крізь клієнт SDK", () => {
  it("Олена — повне представлення", async () => {
    const { result, data } = await call(await connect("olena"), "get_search", { employee_id: "olena" });
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({ id: "s-olena", companyCapUah: 20000 });
  });

  it("Іван — урізане представлення проходить перевірку outputSchema клієнтом; бюджету в відповіді немає", async () => {
    const { result, text, data } = await call(await connect("ivan"), "get_search", { employee_id: "olena" });
    expect(result.isError).toBeFalsy();
    expect(Object.keys(data).sort()).toEqual(["employeeId", "id", "status"]);
    expect(text).not.toContain("18000");
    expect(text).not.toContain("20000");
  });

  it("Максим — not_found з retryable: false", async () => {
    const { result, data } = await call(await connect("maksym"), "get_search", { employee_id: "olena" });
    expect(result.isError).toBe(true);
    expect(data.error).toMatchObject({ code: "not_found", retryable: false });
  });
});

describe("інструменти запису крізь клієнт SDK", () => {
  it("недозволений перехід → isError, invalid_transition; статус не змінився", async () => {
    const { result, data } = await call(await connect("taras"), "update_status", { search_id: "s-olena", to: "secured", reason: "швидше" });
    expect(result.isError).toBe(true);
    expect(data.error.code).toBe("invalid_transition");
    expect(store.searchById("s-olena")?.status).toBe("searching");
  });

  it("notify_employee з полем `to` → помилка ще до обробника, нічого не надіслано", async () => {
    const { result } = await call(await connect("olena"), "notify_employee", { search_id: "s-olena", message: "hi", to: "attacker@evil.test" });
    expect(result.isError).toBe(true);
    expect(store.outbox()).toEqual([]);
  });

  it("сценарій: критерії → шортлист → статус → запит на перегляд (pending_confirmation)", async () => {
    const c = await connect("olena");
    expect((await call(c, "set_criteria", { employee_id: "olena", criteria: { maxBudgetUah: 17000 } })).result.isError).toBeFalsy();
    expect((await call(c, "save_shortlist", { search_id: "s-olena", items: [{ listing_key: "olx:1001", reason: "кіт ок" }] })).data).toMatchObject({ total: 1 });
    expect((await call(c, "update_status", { search_id: "s-olena", to: "shortlist_ready", reason: "є варіант" })).data).toMatchObject({ to: "shortlist_ready" });
    const v = await call(c, "request_viewing", { search_id: "s-olena", listing_key: "olx:1001", slots: ["2026-11-22T15:00:00.000Z"] });
    expect(v.data).toMatchObject({ status: "pending_confirmation" });
    expect(store.searchById("s-olena")?.status).toBe("shortlist_ready");
  });

  it("request_budget_exception → pending; notify_employee → адресат — власниця", async () => {
    const c = await connect("olena");
    expect((await call(c, "request_budget_exception", { search_id: "s-olena", amount_uah: 25000, reason: "кіт" })).data).toMatchObject({ status: "pending" });
    expect((await call(c, "notify_employee", { search_id: "s-olena", message: "Привіт" })).data).toEqual({ sent: true, to: "olena" });
  });
});

describe("стан і principal", () => {
  it("стан спільний між екземплярами сервера (stateless MCP, але один стор на процес)", async () => {
    await call(await connect("olena"), "set_criteria", { employee_id: "olena", criteria: { maxBudgetUah: 16000 } });
    const { data } = await call(await connect("taras"), "get_search", { employee_id: "olena" });
    expect(data.criteria.maxBudgetUah).toBe(16000);
  });

  it("аудит отримує і користувача, і агента", async () => {
    await call(await connect("ivan"), "get_search", { employee_id: "olena" });
    expect(audit).toEqual([expect.objectContaining({ actor: "ivan", agent: AGENT, decision: "allow_partial" })]);
  });

  it("баг у нашому коді → internal_error без деталей; деталі — у logError", async () => {
    const logged: unknown[] = [];
    vi.spyOn(store, "searchByEmployee").mockImplementation(() => {
      throw new Error("SQLITE_BUSY at /srv/db.sqlite");
    });
    const { result, text } = await call(await connect("olena", { logError: (_t, e) => logged.push(e) }), "get_search", { employee_id: "olena" });
    expect(result.isError).toBe(true);
    expect(text).toContain("internal_error");
    expect(text).not.toContain("SQLITE");
    expect(logged).toHaveLength(1);
  });
});
