/**
 * Дочірній процес-воркер для тесту «вбитий воркер». Модель — сценарна і залежить від номера спроби activity:
 *  спроба 1: get_search → search → save_shortlist([A,B]) → друкує SAVED і ЗАВИСАЄ (тест вбиває процес SIGKILL);
 *  спроба 2+: ІНШИЙ шлях (зайвий check_availability) → ті самі save → текст.
 * Ліст відправляє код activity після моделі — тож у спробі 1 він не встигає піти.
 */
import { join } from "node:path";
import { ApplicationFailure, activityInfo } from "@temporalio/activity";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadAgentSpec } from "../../runtime/src/spec.ts";
import type { CallModel, ModelReply } from "../../runtime/src/model.ts";
import { createActivities } from "../src/activities.ts";

const A = "olx:900047514";
const B = "olx:900055433";
const SEARCH = { criteria: { maxBudgetUah: 18000, minRooms: 2, pets: true } };
type Step = [string, unknown] | string;
const first: Step[] = [
  ["relocation__get_search", { employee_id: "olena" }],
  ["listings__search_listings", SEARCH],
  ["relocation__save_shortlist", { search_id: "s-olena", items: [{ listing_key: A }, { listing_key: B }] }],
  "HANG",
];
const retry: Step[] = [
  ["listings__check_availability", { key: A }],
  ["relocation__get_search", { employee_id: "olena" }],
  ["listings__search_listings", SEARCH],
  ["relocation__save_shortlist", { search_id: "s-olena", items: [{ listing_key: A }, { listing_key: B }] }],
  `Нові варіанти: ${A}, ${B}.`,
];

/** Модель рахує власні кроки окремо для кожної спроби (ключ — attempt). */
const counters = new Map<number, number>();
const model: CallModel = async () => {
  const attempt = activityInfo().attempt;
  const i = counters.get(attempt) ?? 0;
  counters.set(attempt, i + 1);
  const step = (attempt === 1 ? first : retry)[i]!;
  const usage = { inputTokens: 1, outputTokens: 1 };
  if (step === "HANG") {
    console.log("SAVED"); // сигнал тесту: шортлист збережено, листа ще немає — вбивай
    return new Promise<ModelReply>(() => {});
  }
  if (typeof step === "string") return { message: { role: "assistant", content: step }, usage, costUsd: 0, model: "scripted" };
  return {
    message: { role: "assistant", content: null, tool_calls: [{ id: `c${attempt}_${i}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] },
    usage, costUsd: 0, model: "scripted",
  };
};

const spec = loadAgentSpec(join(import.meta.dirname, "..", "..", "..", "agents", "scout.yaml"));
const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS! });
const worker = await Worker.create({
  connection,
  taskQueue: process.env.TASK_QUEUE!,
  workflowsPath: join(import.meta.dirname, "..", "src", "workflows.ts"),
  activities: createActivities({
    spec,
    model,
    servers: { listings: process.env.LISTINGS_URL!, relocation: process.env.RELOCATION_URL! },
    now: () => "2026-11-15T09:00:00.000Z",
    authHeaders: async (_server, run) => {
      // REVOKED=1: імітація відкликаного гранту — як у worker.ts, коли запису в data/grants.json немає.
      if (process.env.REVOKED === "1") throw ApplicationFailure.nonRetryable(`Немає гранту ${run.employeeId} → scout`, "grant_missing");
      return { "x-debug-sub": run.employeeId, "x-debug-act": "agent:scout@1" };
    },
  }),
});
console.log("READY");
await worker.run();
