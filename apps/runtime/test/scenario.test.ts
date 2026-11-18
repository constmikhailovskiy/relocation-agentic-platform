import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { viewingGuard } from "../src/hitl.ts";
import type { TraceEvent } from "../src/loop.ts";
import { connectTools } from "../src/mcp-tools.ts";
import type { Message } from "../src/messages.ts";
import { relocationConfirmer } from "../src/relocation-client.ts";
import { createSession, delegationHeaders } from "../src/session.ts";
import { loadAgentSpec } from "../src/spec.ts";
import type { ToolSet } from "../src/tools.ts";
import { scriptedModel } from "./fakes.ts";
import { WORLD_NOW, world } from "./world.ts";

/**
 * Критерій готовності етапу 3, без мережі: «критерії → пошук → шортлист → запит на перегляд».
 * Справжні: специфікація агента, обидва MCP-сервери, allowlist, HITL, маршрут підтвердження.
 * Підставні: лише модель (сценарій) і відповідь людини («так»).
 */
const spec = loadAgentSpec(join(import.meta.dirname, "..", "..", "..", "agents", "concierge.yaml"));
const SLOT = "2026-11-17T15:00:00.000Z";
const opened: ToolSet[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.close()));
});

/** Перший ключ оголошення з останнього результату search_listings — як зробила б модель. */
function firstListingKey(messages: Message[]): string {
  const last = messages.at(-1);
  if (last?.role !== "tool") throw new Error("очікували результат інструмента");
  return (JSON.parse(last.content) as { items: { key: string }[] }).items[0]!.key;
}

async function setup(answer: boolean) {
  const w = world();
  const tools = await connectTools({ servers: w.urls, allowlist: spec.tools, headers: delegationHeaders("olena", spec), fetch: w.fetch });
  opened.push(tools);
  const asked: unknown[] = [];
  const guards = new Map([
    ["relocation.request_viewing", viewingGuard({ ask: async (s) => (asked.push(s), answer), confirm: relocationConfirmer({ baseUrl: w.relocationBaseUrl, sub: "olena", fetch: w.fetch }) })],
  ]);
  let key = "";
  const model = scriptedModel([
    { calls: [["relocation__get_search", { employee_id: "olena" }]] },
    { calls: [["relocation__set_criteria", { employee_id: "olena", criteria: { maxBudgetUah: 19000, minRooms: 2, pets: true } }]] },
    { calls: [["listings__search_listings", { criteria: { maxBudgetUah: 19000, minRooms: 2, pets: true }, limit: 5 }]] },
    (messages) => {
      key = firstListingKey(messages);
      return { calls: [["relocation__save_shortlist", { search_id: "s-olena", items: [{ listing_key: key, reason: "дешевше і з котом" }] }]] };
    },
    { calls: [["relocation__update_status", { search_id: "s-olena", to: "shortlist_ready", reason: "є варіант" }]] },
    () => ({ calls: [["relocation__request_viewing", { search_id: "s-olena", listing_key: key, slots: [SLOT] }]] }),
    "Готово: перегляд підтверджено.",
  ]);
  const trace: TraceEvent[] = [];
  let n = 0;
  const session = createSession({ spec, sub: "olena", now: WORLD_NOW, model, tools, guards, newRunId: () => `run-${++n}`, onTrace: (e) => trace.push(e) });
  return { w, session, trace, asked, model, key: () => key };
}

describe("Повний сценарій Concierge (етап 3: готово, коли…)", () => {
  it("критерії → пошук → шортлист → shortlist_ready → запит на перегляд (людина: так) → viewing_requested", async () => {
    const { w, session, trace, asked, key } = await setup(true);
    const out = await session.send("Шукаю 2-кімнатну до 19 тис., з котом. Знайди і запиши на перегляд найкращу, 17 листопада о 15:00.");

    expect(out).toMatchObject({ kind: "answer", text: "Готово: перегляд підтверджено.", steps: 7 });
    expect(trace.filter((e) => e.type === "tool").map((e) => [e.tool, e.ok])).toEqual([
      ["relocation.get_search", true],
      ["relocation.set_criteria", true],
      ["listings.search_listings", true],
      ["relocation.save_shortlist", true],
      ["relocation.update_status", true],
      ["relocation.request_viewing", true],
    ]);
    // Стан на сервері — не зі слів моделі.
    expect(w.store.searchById("s-olena")).toMatchObject({ status: "viewing_requested", criteria: { maxBudgetUah: 19000 } });
    expect(w.store.shortlist("s-olena").map((i) => i.listingKey)).toEqual([key()]);
    expect(w.store.findApproval((a) => a.kind === "viewing")).toMatchObject({ status: "confirmed", listingKey: key() });
    // Людину спитали рівно раз — і показали саме те, що підтвердилось.
    expect(asked).toEqual([{ searchId: "s-olena", listingKey: key(), slots: [SLOT] }]);
  });

  it("усі виклики агента в аудиті — від імені Олени через concierge@7; підтвердження — Олена без агента", async () => {
    const { w, session } = await setup(true);
    await session.send("давай");
    const agentEvents = w.audit.filter((e) => e.action !== "relocation.confirm_viewing");
    expect(agentEvents.every((e) => e.actor === "olena" && e.agent === "agent:concierge@7")).toBe(true);
    expect(w.audit.find((e) => e.action === "relocation.confirm_viewing")).toMatchObject({ actor: "olena", decision: "allow" });
    expect(w.audit.find((e) => e.action === "relocation.confirm_viewing")?.agent).toBeUndefined();
  });

  it("людина сказала «ні» → запиту немає, статус shortlist_ready; модель дізналась rejected_by_user", async () => {
    const { w, session, model } = await setup(false);
    await session.send("давай");
    expect(w.store.searchById("s-olena")?.status).toBe("shortlist_ready");
    expect(w.store.findApproval((a) => a.kind === "viewing")).toBeUndefined();
    expect(model.requests.at(-1)!.messages.at(-1)!.content).toContain("rejected_by_user");
  });

  it("перше повідомлення моделі — системний промпт з інструкціями і контекстом запуску", async () => {
    const { session, model } = await setup(true);
    await session.send("давай");
    const first = model.requests[0]!.messages[0]!;
    expect(first.role).toBe("system");
    expect(first.content).toContain("employee_id: olena");
    expect(first.content).toContain(WORLD_NOW);
  });

  it("кожен хід чату — новий runId (бюджет запуску в gateway рахується на хід)", async () => {
    const w = world();
    const tools = await connectTools({ servers: w.urls, allowlist: spec.tools, headers: delegationHeaders("olena", spec), fetch: w.fetch });
    opened.push(tools);
    const model = scriptedModel(["перша", "друга"]);
    let n = 0;
    const guards = new Map([["relocation.request_viewing", async () => ({ isError: false, text: "" })]]);
    const session = createSession({ spec, sub: "olena", now: WORLD_NOW, model, tools, guards, newRunId: () => `run-${++n}` });
    await session.send("раз");
    await session.send("два");
    expect(model.requests.map((r) => r.runId)).toEqual(["run-1", "run-2"]);
  });
});

describe("createSession: запуск без HITL для інструмента з високим ризиком не стартує", () => {
  it("request_viewing у специфікації, guard не передано → помилка", async () => {
    const w = world();
    const tools = await connectTools({ servers: w.urls, allowlist: spec.tools, headers: delegationHeaders("olena", spec), fetch: w.fetch });
    opened.push(tools);
    expect(() => createSession({ spec, sub: "olena", now: WORLD_NOW, model: scriptedModel([]), tools, guards: new Map() })).toThrow(/request_viewing/);
  });
});

describe("delegationHeaders", () => {
  it("sub — людина, act — агент із версією", () => {
    expect(delegationHeaders("olena", spec)).toEqual({ "x-debug-sub": "olena", "x-debug-act": "agent:concierge@7" });
  });
});
