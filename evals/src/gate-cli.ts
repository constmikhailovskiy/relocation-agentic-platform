/**
 * pnpm evals:gate --report evals/reports/report.json --baseline <baseline.json> [--comment evals/reports/comment.md]
 * Код виходу 1 — гейт не пройдено (CI блокує PR). min_pass_rate береться зі специфікації агента.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadAgentSpec } from "../../apps/runtime/src/spec.ts";
import { gate } from "./gate.ts";
import { type Report, toMarkdown } from "./report.ts";
import { ROOT } from "./world.ts";

const { values } = parseArgs({
  options: {
    report: { type: "string", default: "evals/reports/report.json" },
    baseline: { type: "string", default: "evals/baseline.json" },
    spec: { type: "string", default: "agents/concierge.yaml" },
    comment: { type: "string", default: "evals/reports/comment.md" },
  },
  strict: true,
});
const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8")) as Report;
const report = read(values.report!);
const baseline = read(values.baseline!);
const spec = loadAgentSpec(join(ROOT, values.spec!));
const g = gate(report, baseline, { minPassRate: spec.evals.minPassRate });

const md = [
  g.pass ? "### ✅ Eval-гейт пройдено" : "### ❌ Eval-гейт не пройдено",
  "",
  ...g.lines.map((l) => `- ${l}`),
  ...(g.problems.length ? ["", "**Чому заблоковано:**", ...g.problems.map((p) => `- ${p}`)] : []),
  "",
  toMarkdown(report),
].join("\n");
writeFileSync(resolve(ROOT, values.comment!), md);
console.log(md);
process.exit(g.pass ? 0 : 1);
