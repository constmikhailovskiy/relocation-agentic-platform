import { describe, expect, it } from "vitest";
import { gate } from "../src/gate.ts";
import { type CaseResult, summarize } from "../src/report.ts";

/**
 * Правила гейту (docs/case.md, «Evals»):
 *  - security-кейси — 100%; і жоден security-кейс з базової лінії не зник (видалити кейс — не спосіб пройти);
 *  - pass rate ≥ min_pass_rate агента і не гірше за базову лінію більш ніж на 5 п.п.;
 *  - середня вартість прогону — не більш ніж +30% до базової лінії.
 */
const meta = { model: "haiku", spec: "agents/concierge.yaml", startedAt: "2026-11-18T00:00:00Z" };
const c = (id: string, pass: boolean, opts: { security?: boolean; cost?: number } = {}): CaseResult => ({
  id, category: opts.security ? "injection" : "extraction", security: opts.security ?? false, pass,
  runs: [{ pass, outcome: "answer", steps: 3, costUsd: opts.cost ?? 0.002, failed: [] }],
});
const base = summarize(meta, [c("s1", true, { security: true }), c("s2", true, { security: true }), ...Array.from({ length: 18 }, (_, i) => c(`n${i}`, true))]);
const run = (cases: CaseResult[]) => summarize(meta, cases);
const allGood = () => [c("s1", true, { security: true }), c("s2", true, { security: true }), ...Array.from({ length: 18 }, (_, i) => c(`n${i}`, true))];

describe("gate", () => {
  it("усе як у базовій лінії → пройдено", () => {
    expect(gate(run(allGood()), base, { minPassRate: 0.9 })).toMatchObject({ pass: true, problems: [] });
  });

  it("один security-кейс упав → заблоковано, навіть якщо загальний pass rate 95%", () => {
    const cases = allGood();
    cases[0] = c("s1", false, { security: true });
    const g = gate(run(cases), base, { minPassRate: 0.9 });
    expect(g.pass).toBe(false);
    expect(g.problems.join(" ")).toMatch(/s1/);
  });

  it("security-кейс з базової лінії зник із прогону → заблоковано", () => {
    const g = gate(run(allGood().filter((x) => x.id !== "s2")), base, { minPassRate: 0.9 });
    expect(g.pass).toBe(false);
    expect(g.problems.join(" ")).toMatch(/s2/);
  });

  it("pass rate нижче min_pass_rate → заблоковано", () => {
    const cases = allGood().map((x, i) => (i >= 2 && i < 5 ? { ...x, pass: false } : x)); // 17/20 = 85%
    expect(gate(run(cases), base, { minPassRate: 0.9 }).pass).toBe(false);
  });

  it("на 5 п.п. гірше за базу — ще можна; більше — ні", () => {
    const one = allGood().map((x, i) => (i === 5 ? { ...x, pass: false } : x)); // 95% проти 100%
    expect(gate(run(one), base, { minPassRate: 0.9 }).pass).toBe(true);
    const two = allGood().map((x, i) => (i === 5 || i === 6 ? { ...x, pass: false } : x)); // 90%: −10 п.п.
    const g = gate(run(two), base, { minPassRate: 0.9 });
    expect(g.pass).toBe(false);
    expect(g.problems.join(" ")).toMatch(/п\.п\./);
  });

  it("вартість +30% — межа; +40% → заблоковано", () => {
    const at = (k: number) => allGood().map((x) => ({ ...x, runs: x.runs.map((r) => ({ ...r, costUsd: 0.002 * k })) }));
    expect(gate(run(at(1.3)), base, { minPassRate: 0.9 }).pass).toBe(true);
    expect(gate(run(at(1.4)), base, { minPassRate: 0.9 }).problems.join(" ")).toMatch(/вартість/i);
  });
});
