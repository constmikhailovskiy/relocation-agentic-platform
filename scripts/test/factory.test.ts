import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Етап 7: правила безпеки фабрики, записані як тест. Workflow — це конфіг, і саме в конфігу ховаються
 * найдорожчі помилки: зайвий дозвіл, тег замість SHA, тригер від будь-кого на публічному репо.
 * Тест ловить, якщо хтось (зокрема сам агент фабрики) послабить ці правила.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const WF_PATH = join(ROOT, ".github", "workflows", "factory.yml");
const read = (p: string) => readFileSync(p, "utf8");

interface Step { uses?: string; with?: Record<string, string>; run?: string }
interface Job { if?: string; "timeout-minutes"?: number; permissions?: Record<string, string>; steps: Step[] }
interface Workflow { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> }

const load = () => parse(read(WF_PATH)) as Workflow;
const onlyJob = (wf: Workflow) => {
  const jobs = Object.values(wf.jobs);
  expect(jobs).toHaveLength(1);
  return jobs[0]!;
};

describe("factory.yml: хто і як запускає агента", () => {
  it("файл існує", () => {
    expect(existsSync(WF_PATH)).toBe(true);
  });

  it("тригер — лише лейбл на issue: жодних коментарів, PR чи pull_request_target", () => {
    const wf = load();
    expect(Object.keys(wf.on)).toEqual(["issues"]);
    expect(wf.on.issues).toEqual({ types: ["labeled"] });
  });

  it("job запускається лише на лейбл agent і лише коли лейбл поставив власник репо", () => {
    const cond = onlyJob(load()).if ?? "";
    expect(cond).toContain("github.event.label.name == 'agent'");
    expect(cond).toContain("github.event.sender.login == github.repository_owner");
  });
});

describe("factory.yml: що агент може і чого ні", () => {
  it("дозволи: на рівні workflow — нічого; GITHUB_TOKEN job-а лише читає (пише токен Claude App)", () => {
    const wf = load();
    expect(wf.permissions).toEqual({});
    expect(onlyJob(wf).permissions).toEqual({
      contents: "read",
      issues: "read",
      "pull-requests": "read",
      "id-token": "write", // OIDC: action обмінює його на короткоживучий токен Claude GitHub App
    });
  });

  it("кожна сторонній action закріплена за SHA (40 hex), не за тегом", () => {
    for (const s of onlyJob(load()).steps) {
      if (s.uses) expect(s.uses, s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("є стеля часу (≤ 30 хв) і стеля кроків моделі", () => {
    const job = onlyJob(load());
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
    const claude = job.steps.find((s) => s.uses?.startsWith("anthropics/claude-code-action@"));
    expect(claude?.with?.claude_args ?? "").toMatch(/--max-turns \d+/);
  });

  it("агент не ходить в інтернет: WebFetch і WebSearch заборонені", () => {
    const claude = onlyJob(load()).steps.find((s) => s.uses?.startsWith("anthropics/claude-code-action@"));
    expect(claude?.with?.claude_args ?? "").toMatch(/--disallowedTools[^\n]*WebFetch/);
    expect(claude?.with?.claude_args ?? "").toMatch(/--disallowedTools[^\n]*WebSearch/);
  });

  it("єдиний секрет — окремий ключ фабрики; ключ evals сюди не потрапляє", () => {
    const secrets = [...read(WF_PATH).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(["FACTORY_ANTHROPIC_API_KEY"]));
  });
});

describe("CODEOWNERS: що агент не міняє без рев'ю власника", () => {
  const owners = () => read(join(ROOT, ".github", "CODEOWNERS"));
  it.each([
    "/packages/shared/src/policy.ts",
    "/packages/shared/src/auth.ts",
    "/apps/runtime/src/sts.ts",
    "/.github/",
    "/evals/baseline.json",
    "/evals/cases/",
    "/agents/",
  ])("%s має власника", (path) => {
    const line = owners().split("\n").find((l) => l.startsWith(`${path} `));
    expect(line, `немає рядка для ${path}`).toMatch(/@\S+/);
  });
});
