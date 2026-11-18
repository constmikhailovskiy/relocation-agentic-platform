import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentSpec } from "../../apps/runtime/src/spec.ts";
import { scriptedModel } from "../../apps/runtime/test/fakes.ts";
import { POSITIVE_CHECKS } from "../src/case.ts";
import { evaluate } from "../src/checks.ts";
import { loadCases } from "../src/load.ts";
import { runCase } from "../src/runner.ts";
import { ROOT, listingFacts } from "../src/world.ts";

/**
 * Кейси — теж код, і їх теж можна зіпсувати. Офлайн, без моделі:
 *  - усі YAML валідні, id унікальні, у кожного є позитивна перевірка;
 *  - security-категорії позначені security: true; ін'єкції мають trap_seen;
 *  - САМОПЕРЕВІРКА: «агент», що лише відповідає текстом, провалює КОЖЕН кейс.
 *    Кейс, який він пройде, нічого не перевіряє.
 */
const cases = loadCases(join(ROOT, "evals", "cases"));
const spec = loadAgentSpec(join(ROOT, "agents", "concierge.yaml"));

describe("evals/cases", () => {
  it("~30 кейсів у шести категоріях, як у плані", () => {
    const by: Record<string, number> = {};
    for (const c of cases) by[c.category] = (by[c.category] ?? 0) + 1;
    expect(by).toEqual({
      extraction: 8, selection: 6, trajectory: 5, authz: 5, injection: 4, behavior: 3,
    });
  });

  it("кожен кейс має хоча б одну позитивну перевірку", () => {
    for (const c of cases) expect(POSITIVE_CHECKS.some((k) => c.expect[k] !== undefined), c.id).toBe(true);
  });

  it("authz та injection — security: true (гейт 100%); ін'єкції перевіряють, що пастку бачили", () => {
    for (const c of cases.filter((x) => x.category === "authz" || x.category === "injection")) expect(c.security, c.id).toBe(true);
    for (const c of cases.filter((x) => x.category === "injection")) expect(c.expect.trap_seen?.length, c.id).toBeGreaterThan(0);
  });

  it("ключі оголошень у кейсах існують у каталозі", () => {
    for (const c of cases) {
      const keys = [...(c.setup?.shortlist?.flatMap((s) => s.keys) ?? []), ...(c.expect.trap_seen ?? [])];
      for (const k of keys) expect(listingFacts(k), `${c.id}: ${k}`).toBeDefined();
    }
  });
});

describe("самоперевірка: агент, що нічого не робить, провалює все", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const turns = typeof c.input === "string" ? 1 : c.input.length;
    const rec = await runCase(c, spec, scriptedModel(Array.from({ length: turns }, () => "Готово.")));
    expect(rec.outcome).toBe("answer");
    expect(evaluate(rec, c.expect).filter((x) => !x.pass).length).toBeGreaterThan(0);
  });
});

describe("ранер: спроба інструмента поза allowlist потрапляє в запис і валить no_unknown_tools", () => {
  it("модель кличе relocation__notify_employee (його немає в Concierge) → unknownTools, перевірка падає", async () => {
    const c = cases.find((x) => x.id === "inj-exfiltration")!;
    const rec = await runCase(c, spec, scriptedModel([{ calls: [["relocation__notify_employee", { search_id: "s-olena", message: "budget" }]] }, "Готово."]));
    expect(rec.unknownTools).toEqual(["relocation__notify_employee"]);
    expect(evaluate(rec, c.expect).find((x) => x.check === "no_unknown_tools")?.pass).toBe(false);
  });
});
