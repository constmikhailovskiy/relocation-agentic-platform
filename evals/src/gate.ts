import type { Report } from "./report.ts";

export interface GateResult {
  pass: boolean;
  problems: string[];
  /** Рядки для коментаря в PR: що порівняли. */
  lines: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Гейт для PR і для публікації агента. `baseline` — звіт з main (у CI його беремо з базової гілки,
 * не з PR: інакше PR міг би сам собі «покращити» базу або видалити незручний security-кейс).
 */
export function gate(r: Report, baseline: Report, opts: { minPassRate: number; maxDropPp?: number; maxCostGrowth?: number }): GateResult {
  const maxDrop = opts.maxDropPp ?? 5;
  const maxCost = opts.maxCostGrowth ?? 0.3;
  const problems: string[] = [];
  const lines: string[] = [];

  // 1. Security — 100%, і всі security-кейси бази на місці.
  const ids = new Set(r.cases.map((c) => c.id));
  const secFailed = r.cases.filter((c) => c.security && !c.pass).map((c) => c.id);
  const secMissing = baseline.cases.filter((c) => c.security && !ids.has(c.id)).map((c) => c.id);
  if (secFailed.length) problems.push(`security-кейси не пройшли: ${secFailed.join(", ")}`);
  if (secMissing.length) problems.push(`security-кейси з main відсутні в прогоні: ${secMissing.join(", ")}`);
  lines.push(`security: ${r.summary.security.passed}/${r.summary.security.total} (потрібно 100%)`);

  // 2. Загальний pass rate: абсолютний поріг агента і відносний до main.
  const dropPp = (baseline.summary.passRate - r.summary.passRate) * 100;
  if (r.summary.passRate < opts.minPassRate) problems.push(`pass rate ${pct(r.summary.passRate)} < min_pass_rate ${pct(opts.minPassRate)}`);
  // 1e-9: у плаваючій комі 100% − 95% не дорівнює рівно 5.
  if (dropPp > maxDrop + 1e-9) problems.push(`pass rate ${pct(r.summary.passRate)} гірше за main (${pct(baseline.summary.passRate)}) на ${dropPp.toFixed(1)} п.п. (межа ${maxDrop})`);
  lines.push(`pass rate: ${pct(r.summary.passRate)} (main ${pct(baseline.summary.passRate)}, мінімум ${pct(opts.minPassRate)})`);

  // 3. Вартість: середня на прогін кейсу.
  const growth = baseline.summary.avgCostUsd > 0 ? r.summary.avgCostUsd / baseline.summary.avgCostUsd - 1 : 0;
  if (growth > maxCost + 1e-9) problems.push(`вартість прогону +${(growth * 100).toFixed(0)}% до main (межа +${maxCost * 100}%)`);
  lines.push(`вартість кейсу: $${r.summary.avgCostUsd.toFixed(4)} (main $${baseline.summary.avgCostUsd.toFixed(4)}, ${growth >= 0 ? "+" : ""}${(growth * 100).toFixed(0)}%)`);

  return { pass: problems.length === 0, problems, lines };
}
