import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HIGH_RISK_TOOLS } from "../src/hitl.ts";
import { connectTools } from "../src/mcp-tools.ts";
import { assertGuarded, loadAgentSpec, systemPrompt } from "../src/spec.ts";
import { world } from "./world.ts";

const CONCIERGE = join(import.meta.dirname, "..", "..", "..", "agents", "concierge.yaml");

describe("agents/concierge.yaml", () => {
  it("валідна за AgentSpec", () => {
    const spec = loadAgentSpec(CONCIERGE);
    expect(spec).toMatchObject({ id: "concierge", version: 7, dataClass: "internal", limits: { maxSteps: 12, maxCostUsdPerRun: 0.2 } });
  });

  it("кожен інструмент зі специфікації існує на серверах (інакше агент зламається вже в розмові)", async () => {
    const w = world();
    const tools = await connectTools({ servers: w.urls, allowlist: loadAgentSpec(CONCIERGE).tools, authHeaders: async () => ({ "x-debug-sub": "olena" }), fetch: w.fetch });
    expect(tools.defs).toHaveLength(loadAgentSpec(CONCIERGE).tools.length);
    await tools.close();
  });

  it("агент не має інструментів, яких Concierge не потрібні: notify_employee, request_budget_exception", () => {
    const { tools } = loadAgentSpec(CONCIERGE);
    expect(tools).not.toContain("relocation.notify_employee");
    expect(tools).not.toContain("relocation.request_budget_exception");
  });
});

describe("loadAgentSpec: невалідна специфікація — помилка зі шляхом до поля", () => {
  it("файл з полем не того типу", () => {
    expect(() => loadAgentSpec(join(import.meta.dirname, "fixtures", "bad-spec.yaml"))).toThrow(/limits\.maxSteps/);
  });
});

describe("assertGuarded: інструмент з високим ризиком без guard → запуск не стартує", () => {
  it("request_viewing у специфікації без guard → помилка", () => {
    expect(() => assertGuarded(["relocation.request_viewing"], new Map())).toThrow(/relocation\.request_viewing/);
  });

  it("з guard — ок; інструменти без ризику guard не потребують", () => {
    expect(() => assertGuarded(["relocation.get_search", ...HIGH_RISK_TOOLS], new Map(HIGH_RISK_TOOLS.map((t) => [t, async () => ({ isError: false, text: "" })])))).not.toThrow();
  });
});

describe("systemPrompt", () => {
  it("інструкції агента + хто користувач і котра година (від runtime, не від моделі)", () => {
    const p = systemPrompt(loadAgentSpec(CONCIERGE), { sub: "olena", now: "2026-11-15T09:00:00.000Z" });
    expect(p).toContain("Ти — Concierge");
    expect(p).toContain("employee_id: olena");
    expect(p).toContain("2026-11-15T09:00:00.000Z");
  });
});
