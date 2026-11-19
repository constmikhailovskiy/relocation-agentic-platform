import { type ChildProcess, spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { world } from "../../runtime/test/world.ts";
import { type SearchWorkflowInput, closeSearch, searchWorkflow, statusQuery } from "../src/workflows.ts";

/**
 * КРИТЕРІЙ ЕТАПУ 6: «вбитий воркер не дає ні втрати прогресу, ні дубля листа».
 * Справжній сервер Temporal (dev-сервер з @temporalio/testing), справжні MCP-сервери на портах,
 * воркер — окремий процес, який ми вбиваємо SIGKILL посеред runScout (після save_shortlist, до листа).
 * Запуск: pnpm test:temporal (потрібен бінарник dev-сервера; перший раз SDK його завантажує).
 */
const A = "olx:900047514";
const B = "olx:900055433";
let env: TestWorkflowEnvironment;
const w = world();
const servers: { close: () => void }[] = [];
const children: ChildProcess[] = [];
const urls = { listings: "", relocation: "" };

function listen(app: { fetch: (r: Request) => Response | Promise<Response> }): Promise<string> {
  return new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}/mcp`));
    servers.push(s);
  });
}

function startWorker(taskQueue: string, extraEnv: Record<string, string> = {}): { proc: ChildProcess; saved: Promise<void>; ready: Promise<void> } {
  const proc = spawn(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", join(import.meta.dirname, "child-worker.ts")], {
    env: { ...process.env, ...extraEnv, TEMPORAL_ADDRESS: env.address, TASK_QUEUE: taskQueue, LISTINGS_URL: urls.listings, RELOCATION_URL: urls.relocation },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(proc);
  let out = "";
  const waitFor = (marker: string) =>
    new Promise<void>((resolve) => {
      proc.stdout!.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes(marker)) resolve();
      });
    });
  return { proc, saved: waitFor("SAVED"), ready: waitFor("READY") };
}

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  urls.listings = await listen(w.listingsApp);
  urls.relocation = await listen(w.relocationApp);
}, 120_000);

afterAll(async () => {
  for (const c of children) c.kill("SIGKILL");
  for (const s of servers) s.close();
  await env?.teardown();
});

describe("searchWorkflow: воркер вбито SIGKILL посеред runScout", () => {
  it("друга копія воркера доводить ітерацію: шортлист цілий, лист рівно один, newItems = 2", async () => {
    const taskQueue = `kill-${Date.now()}`;
    const first = startWorker(taskQueue);
    await first.ready;

    const input: SearchWorkflowInput = {
      searchId: "s-olena",
      employeeId: "olena",
      tick: "1 second",
      maxIterations: 1,
      timeouts: { startToClose: "2 minutes", heartbeat: "3 seconds", retryInitial: "1 second" },
    };
    const handle = await env.client.workflow.start(searchWorkflow, { taskQueue, workflowId: `search-s-olena-${taskQueue}`, args: [input] });

    await first.saved;
    // Шортлист уже збережено, листа ще немає — і саме тепер воркер «помирає».
    expect(w.store.shortlist("s-olena").map((i) => i.listingKey)).toEqual([A, B]);
    expect(w.store.outbox()).toHaveLength(0);
    first.proc.kill("SIGKILL");
    await new Promise((r) => first.proc.once("exit", r));

    const second = startWorker(taskQueue);
    await second.ready;
    expect(await handle.result()).toBe("max_iterations");

    // Немає дубля листа і немає «хибного порожнього дня».
    expect(w.store.outbox()).toHaveLength(1);
    expect(w.store.shortlist("s-olena").map((i) => i.listingKey)).toEqual([A, B]);
    const status = await handle.query(statusQuery);
    expect(status).toMatchObject({ iteration: 1, emptyDays: 0, failedRuns: 0, last: { newItems: 2, notified: true } });
    // runKey унікальний для КОЖНОГО старту workflow (інакше другий старт того ж пошуку «з'їв» би лист першого
    // через однаковий ключ ідемпотентності), але стабільний між ретраями і continueAsNew.
    expect(status.lastRunKey).toBe(`s-olena:${handle.firstExecutionRunId}:0`);

    // Прогрес не втрачено: знімок шортлиста не перезапускався (його результат — з історії),
    // а runScout мав другу спробу — саме ту, яку підхопив новий воркер.
    const history = await handle.fetchHistory();
    const scheduled = (history.events ?? []).filter((e) => e.activityTaskScheduledEventAttributes);
    const names = scheduled.map((e) => e.activityTaskScheduledEventAttributes!.activityType!.name);
    expect(names.filter((n) => n === "snapshotShortlist")).toHaveLength(1);
    const started = (history.events ?? []).filter((e) => e.activityTaskStartedEventAttributes);
    expect(Math.max(...started.map((e) => e.activityTaskStartedEventAttributes!.attempt ?? 1))).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

describe("searchWorkflow: грант відкликано", () => {
  it("activity кидає grant_missing (nonRetryable) → workflow не падає, а ставить пошук на паузу; закривається сигналом", async () => {
    const taskQueue = `revoked-${Date.now()}`;
    const worker = startWorker(taskQueue, { REVOKED: "1" });
    await worker.ready;
    const handle = await env.client.workflow.start(searchWorkflow, {
      taskQueue,
      workflowId: `search-revoked-${taskQueue}`,
      args: [{ searchId: "s-maksym", employeeId: "maksym", tick: "1 second", timeouts: { heartbeat: "3 seconds", retryInitial: "1 second" } }],
    });
    let status = await handle.query(statusQuery);
    for (let i = 0; i < 40 && !status.paused; i++) {
      await new Promise((r) => setTimeout(r, 250));
      status = await handle.query(statusQuery);
    }
    expect(status).toMatchObject({ paused: true, pausedReason: "grant_missing", failedRuns: 1 });
    await handle.signal(closeSearch, "cancelled");
    expect(await handle.result()).toBe("cancelled");
  }, 60_000);
});
