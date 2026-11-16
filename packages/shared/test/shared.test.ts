import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentSpec,
  Criteria,
  SearchStatus,
  TERMINAL,
  TRANSITIONS,
  assertTransition,
  canTransition,
  districtFromUk,
} from "@reloc/shared";

describe("Criteria", () => {
  it("підставляє дефолти", () => {
    const c = Criteria.parse({ maxBudgetUah: 18000 });
    expect(c).toMatchObject({ minRooms: 1, districts: [], pets: false, mustHave: [] });
  });

  it("відхиляє район, що одночасно бажаний і виключений", () => {
    const r = Criteria.safeParse({ maxBudgetUah: 18000, districts: ["sykhivskyi"], excludeDistricts: ["sykhivskyi"] });
    expect(r.success).toBe(false);
  });

  it("відхиляє невідомий район — модель не може вигадати 'center'", () => {
    const r = Criteria.safeParse({ maxBudgetUah: 18000, districts: ["center"] });
    expect(r.success).toBe(false);
  });

  it("генерує JSON Schema для інструмента", () => {
    const schema = z.toJSONSchema(Criteria, { io: "input" }) as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties)).toContain("maxBudgetUah");
    // На вході обов'язковий лише бюджет — решта має дефолти.
    expect(schema.required).toEqual(["maxBudgetUah"]);
  });
});

describe("Статуси пошуку", () => {
  it("описані всі статуси", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...SearchStatus.options].sort());
  });

  it("з кінцевих станів виходу немає", () => {
    for (const s of TERMINAL) expect(TRANSITIONS[s]).toHaveLength(0);
  });

  it("не можна перескочити з пошуку одразу в secured", () => {
    expect(canTransition("searching", "secured")).toBe(false);
    expect(() => assertTransition("searching", "secured")).toThrow(/Дозволені з searching/);
  });

  it("з кожного некінцевого стану можна дійти до cancelled (немає пасток без виходу)", () => {
    const reachable = (from: SearchStatus, seen = new Set<SearchStatus>()): Set<SearchStatus> => {
      seen.add(from);
      for (const to of TRANSITIONS[from]) if (!seen.has(to)) reachable(to, seen);
      return seen;
    };
    for (const s of SearchStatus.options) {
      if (TERMINAL.has(s)) continue;
      const r = reachable(s);
      expect(r.has("cancelled"), s).toBe(true);
    }
  });
});

describe("Довідник Львова", () => {
  it("розпізнає райони в різних написаннях", () => {
    expect(districtFromUk("Франківський район")).toBe("frankivskyi");
    expect(districtFromUk("сихівський")).toBe("sykhivskyi");
    expect(districtFromUk("Центр")).toBeUndefined();
  });
});

describe("AgentSpec", () => {
  const base = {
    id: "concierge",
    version: 1,
    owner: "bohdan@example.test",
    description: "Допомагає знайти оренду у Львові",
    model: { primary: "claude-haiku-5-5" },
    dataClass: "internal",
    instructions: "Ти допомагаєш новим працівникам знайти житло...",
    tools: ["listings.search_listings"],
    limits: { maxSteps: 12, maxCostUsdPerRun: 0.2, dailyBudgetUsd: 5 },
    audience: { roles: ["new_hire"] },
    evals: { suite: "concierge", minPassRate: 0.9, securityMustPass: true },
  };

  it("валідна специфікація парситься", () => {
    expect(AgentSpec.safeParse(base).success).toBe(true);
  });

  it("security-гейт не можна вимкнути", () => {
    const r = AgentSpec.safeParse({ ...base, evals: { ...base.evals, securityMustPass: false } });
    expect(r.success).toBe(false);
  });

  it("інструмент має формат server.tool", () => {
    const r = AgentSpec.safeParse({ ...base, tools: ["search_listings"] });
    expect(r.success).toBe(false);
  });
});
