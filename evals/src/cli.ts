/**
 * pnpm evals [--only id1,id2|category] [--repeat N] [--model haiku] [--spec agents/concierge.yaml]
 *            [--budget 1] [--out evals/reports/report.json] [--concurrency 3]
 *
 * Справжні виклики моделі через gateway у пам'яті процесу. Потрібен ANTHROPIC_API_KEY (з .env локально,
 * із секрету в CI). Немає ключа — помилка, а не «0 кейсів пройдено».
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadAgentSpec } from "../../apps/runtime/src/spec.ts";
import type { EvalCase } from "./case.ts";
import { evaluate } from "./checks.ts";
import { evalGateway } from "./gateway.ts";
import { judge } from "./judge.ts";
import { loadCases } from "./load.ts";
import { type CaseResult, type RunResult, summarize, toMarkdown } from "./report.ts";
import { runCase } from "./runner.ts";
import { ROOT } from "./world.ts";

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    repeat: { type: "string" },
    model: { type: "string", default: "haiku" },
    spec: { type: "string", default: "agents/concierge.yaml" },
    budget: { type: "string", default: "1" },
    out: { type: "string", default: "evals/reports/report.json" },
    concurrency: { type: "string", default: "3" },
    "judge-model": { type: "string", default: "sonnet" },
    /** Security-кейси ганяємо кілька разів: 1 з 3 — це вже провал (ймовірнісна поведінка моделі). */
    "security-repeat": { type: "string", default: "3" },
  },
  strict: true,
});

const key = process.env.ANTHROPIC_API_KEY;
if (!key && values.model !== "mock") {
  console.error("ANTHROPIC_API_KEY не задано. Evals без моделі нічого не доводять — зупиняюсь.");
  process.exit(2);
}

const specPath = resolve(ROOT, values.spec!);
const spec = loadAgentSpec(specPath);
let cases = loadCases(join(ROOT, "evals", "cases"));
if (values.only) {
  const want = new Set(values.only.split(","));
  cases = cases.filter((c) => want.has(c.id) || want.has(c.category));
}
const repeatOverride = values.repeat ? Number(values.repeat) : undefined;
const gw = evalGateway({ anthropicKey: key, budgetUsd: Number(values.budget) });
const model = gw.model(values.model!, `${spec.id}@${spec.version}`);
const judgeModel = gw.model(values["judge-model"]!, "judge");
let judgeCostUsd = 0;

async function runOne(c: EvalCase): Promise<CaseResult> {
  const runs: RunResult[] = [];
  const n = repeatOverride ?? (c.security ? Math.max(c.repeat, Number(values["security-repeat"])) : c.repeat);
  for (let i = 0; i < n; i++) {
    const rec = await runCase(c, spec, model);
    const checks = evaluate(rec, c.expect);
    // Judge — лише якщо детерміновані перевірки пройшли: немає сенсу платити за оцінку тону вже проваленого прогону.
    if (c.expect.judge && checks.every((x) => x.pass)) {
      const v = await judge(judgeModel, typeof c.input === "string" ? [c.input] : c.input, rec, c.expect.judge);
      judgeCostUsd += v.costUsd;
      checks.push({ check: v.check, pass: v.pass, detail: v.detail });
    }
    const failed = checks.filter((x) => !x.pass);
    runs.push({ pass: failed.length === 0, outcome: rec.outcome, steps: rec.steps, costUsd: rec.costUsd, failed, response: rec.response.slice(0, 1200), calls: rec.toolCalls.map((t) => `${t.ref}(${JSON.stringify(t.args)}) → ${t.ok ? "ok" : t.error}`), ...(rec.error && { error: rec.error }) });
    const mark = failed.length === 0 ? "✓" : "✗";
    console.log(`${mark} ${c.id}${n > 1 ? ` #${i + 1}` : ""} · ${rec.steps} кроків · $${rec.costUsd.toFixed(4)}${failed.length ? `\n    ${failed.map((f) => `${f.check}: ${f.detail}`).join("\n    ")}` : ""}`);
  }
  return { id: c.id, category: c.category, security: c.security, pass: runs.every((r) => r.pass), runs };
}

// Невелика паралельність: кейси незалежні (кожен — свій світ), але провайдер має ліміти швидкості.
const results: CaseResult[] = new Array(cases.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
    while (next < cases.length) {
      const i = next++;
      results[i] = await runOne(cases[i]!);
    }
  }),
);

const report = summarize({ model: values.model!, spec: values.spec!, startedAt: new Date().toISOString() }, results, judgeCostUsd);
const out = resolve(ROOT, values.out!);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n${toMarkdown(report)}\n\nзвіт: ${out} · витрачено в gateway: $${gw.spentUsd().toFixed(4)}`);
