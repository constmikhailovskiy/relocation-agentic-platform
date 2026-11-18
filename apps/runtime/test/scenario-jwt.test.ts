import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { viewingGuard } from "../src/hitl.ts";
import { connectTools } from "../src/mcp-tools.ts";
import { relocationConfirmer } from "../src/relocation-client.ts";
import { createSession } from "../src/session.ts";
import { loadAgentSpec } from "../src/spec.ts";
import { assertAudience, createSts, delegatedAuthHeaders, userVerifier } from "../src/sts.ts";
import type { ToolSet } from "../src/tools.ts";
import { scriptedModel, type Turn } from "./fakes.ts";
import { WORLD_NOW, jwtWorld } from "./world.ts";

/**
 * Етап 4 наскрізно, без мережі: справжні JWT, справжні сервери в JWT-режимі.
 * Людина → (токен IdP) → runtime перевіряє → STS підписує на КОЖЕН запит → сервери перевіряють.
 */
const spec = loadAgentSpec(join(import.meta.dirname, "..", "..", "..", "agents", "concierge.yaml"));
const SLOT = "2026-11-17T15:00:00.000Z";
const opened: ToolSet[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.close()));
});

async function login(username: string, roles: string[], turns: Turn[], answer = true) {
  const w = await jwtWorld();
  const token = await w.userToken(username, roles);
  const user = await userVerifier({ issuer: w.IDP_ISSUER, audience: "relocation-cli", keys: w.idpKeys, now: w.now })(token);
  assertAudience(spec, user);
  const sts = createSts({ privateKey: w.runtimePrivateKey, kid: "ES256-1", now: w.now });
  const current = { runId: "" };
  const tools = await connectTools({
    servers: w.urls,
    allowlist: spec.tools,
    authHeaders: delegatedAuthHeaders(sts, user, `agent:${spec.id}@${spec.version}`, current),
    fetch: w.fetch,
  });
  opened.push(tools);
  const guards = new Map([
    ["relocation.request_viewing", viewingGuard({
      ask: async () => answer,
      // Підтвердження — ТОКЕНОМ ЛЮДИНИ від IdP, не делегованим.
      confirm: relocationConfirmer({ baseUrl: w.relocationBaseUrl, authHeaders: async () => ({ authorization: `Bearer ${token}` }), fetch: w.fetch }),
    })],
  ]);
  const model = scriptedModel(turns);
  let n = 0;
  const session = createSession({ spec, sub: user.sub, now: WORLD_NOW, model, tools, guards, newRunId: () => (current.runId = `run-${++n}`) });
  return { w, session, model, tools };
}

describe("JWT наскрізно: Олена", () => {
  it("шортлист → перегляд → підтвердження токеном IdP; аудит з run_id ходу", async () => {
    const { w, session } = await login("olena", ["new_hire"], [
      { calls: [["relocation__save_shortlist", { search_id: "s-olena", items: [{ listing_key: "olx:1001" }] }]] },
      { calls: [["relocation__update_status", { search_id: "s-olena", to: "shortlist_ready", reason: "є варіант" }]] },
      { calls: [["relocation__request_viewing", { search_id: "s-olena", listing_key: "olx:1001", slots: [SLOT] }]] },
      "Готово",
    ]);
    expect(await session.send("давай")).toMatchObject({ kind: "answer" });
    expect(w.store.searchById("s-olena")?.status).toBe("viewing_requested");
    const byAgent = w.audit.filter((e) => e.agent);
    expect(byAgent.length).toBeGreaterThan(0);
    expect(byAgent.every((e) => e.actor === "olena" && e.agent === `agent:concierge@${spec.version}` && e.runId === "run-1")).toBe(true);
    expect(w.audit.find((e) => e.action === "relocation.confirm_viewing")).toMatchObject({ actor: "olena", decision: "allow" });
  });

  it("токен підписується на кожен запит: через 6 хвилин після підключення виклики працюють", async () => {
    const { w, session } = await login("olena", ["new_hire"], [{ calls: [["relocation__get_search", { employee_id: "olena" }]] }, "ок"]);
    w.clock.now = new Date(w.clock.now.getTime() + 6 * 60_000);
    await session.send("мій пошук?");
    expect(w.audit.at(-1)).toMatchObject({ action: "relocation.get_search", decision: "allow" });
  });
});

describe("Критерій етапу 4: Іван не бачить бюджет Олени навіть через агента", () => {
  it("get_search по Олені → лише статус; у жодному результаті інструмента немає 18000 чи 20000", async () => {
    const { session, model } = await login("ivan", ["hiring_manager"], [
      { calls: [["relocation__get_search", { employee_id: "olena" }]] },
      { calls: [["relocation__set_criteria", { employee_id: "olena", criteria: { maxBudgetUah: 15000 } }]] },
      "Бачу лише статус",
    ]);
    await session.send("Покажи бюджет і критерії Олени");
    const toolMessages = model.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content as string);
    expect(toolMessages).toHaveLength(2);
    for (const text of toolMessages) {
      expect(text).not.toContain("18000");
      expect(text).not.toContain("20000");
    }
    expect(JSON.parse(toolMessages[0]!)).toEqual({ id: "s-olena", employeeId: "olena", status: "searching" });
    expect(toolMessages[1]).toContain("forbidden");
  });
});

describe("audience агента", () => {
  it("Богдан (agent_builder) не запустить Concierge — ще до першого виклику моделі", async () => {
    await expect(login("bohdan", ["agent_builder"], [])).rejects.toThrow(/bohdan/);
  });
});
