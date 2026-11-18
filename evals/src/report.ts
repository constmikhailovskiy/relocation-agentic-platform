import type { Category, EvalCase, RunRecord } from "./case.ts";
import type { CheckResult } from "./checks.ts";

export interface RunResult {
  pass: boolean;
  outcome: RunRecord["outcome"];
  steps: number;
  costUsd: number;
  failed: CheckResult[];
  /** Відповідь агента (обрізана) — щоб розбирати провали без повторного прогону. */
  response?: string;
  /** Виклики інструментів: ref(args) → ok | код помилки. */
  calls?: string[];
  error?: string;
}

export interface CaseResult {
  id: string;
  category: Category;
  security: boolean;
  /** Кейс пройдено, лише якщо пройдено ВСІ повтори. */
  pass: boolean;
  runs: RunResult[];
}

export interface Report {
  model: string;
  spec: string;
  startedAt: string;
  cases: CaseResult[];
  summary: {
    total: number;
    passed: number;
    passRate: number;
    security: { total: number; passed: number };
    byCategory: Record<string, { total: number; passed: number }>;
    /** Середня вартість одного прогону кейсу (усі повтори). */
    avgCostUsd: number;
    avgSteps: number;
    totalCostUsd: number;
  };
}

export function summarize(meta: { model: string; spec: string; startedAt: string }, cases: CaseResult[], extraCostUsd = 0): Report {
  const runs = cases.flatMap((c) => c.runs);
  const byCategory: Report["summary"]["byCategory"] = {};
  for (const c of cases) {
    const b = (byCategory[c.category] ??= { total: 0, passed: 0 });
    b.total++;
    if (c.pass) b.passed++;
  }
  const sec = cases.filter((c) => c.security);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    ...meta,
    cases,
    summary: {
      total: cases.length,
      passed: cases.filter((c) => c.pass).length,
      passRate: cases.length ? cases.filter((c) => c.pass).length / cases.length : 0,
      security: { total: sec.length, passed: sec.filter((c) => c.pass).length },
      byCategory,
      avgCostUsd: runs.length ? sum(runs.map((r) => r.costUsd)) / runs.length : 0,
      avgSteps: runs.length ? sum(runs.map((r) => r.steps)) / runs.length : 0,
      totalCostUsd: sum(runs.map((r) => r.costUsd)) + extraCostUsd,
    },
  };
}

/** Таблиця для консолі і коментаря в PR (Markdown). */
export function toMarkdown(r: Report): string {
  const pct = (p: number, t: number) => (t ? `${Math.round((p / t) * 100)}%` : "—");
  const lines = [
    `**Evals** · модель \`${r.model}\` · кейсів ${r.summary.total} · пройдено ${r.summary.passed} (${pct(r.summary.passed, r.summary.total)}) · security ${r.summary.security.passed}/${r.summary.security.total} · $${r.summary.totalCostUsd.toFixed(4)}`,
    "",
    "| Категорія | Пройдено |",
    "| --- | --- |",
    ...Object.entries(r.summary.byCategory).map(([k, v]) => `| ${k} | ${v.passed}/${v.total} |`),
  ];
  const failed = r.cases.filter((c) => !c.pass);
  if (failed.length) {
    lines.push("", "**Не пройшли:**", "");
    for (const c of failed) {
      const bad = c.runs.find((x) => !x.pass);
      const why = bad?.failed.map((f) => `${f.check}: ${f.detail}`).join("; ") ?? "";
      lines.push(`- \`${c.id}\`${c.security ? " **[security]**" : ""} — ${why.slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}
