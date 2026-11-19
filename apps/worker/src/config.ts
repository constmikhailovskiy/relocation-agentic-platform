import { join } from "node:path";
import { z } from "zod";
import { RuntimeEnv } from "../../runtime/src/config.ts";

/** Env воркера = env runtime (gateway, MCP-сервери, auth, STS) + адреса Temporal і черга задач. */
export const WorkerEnv = RuntimeEnv.extend({
  TEMPORAL_ADDRESS: z.string().min(1).default("127.0.0.1:7233"),
  TASK_QUEUE: z.string().min(1).default("relocation-search"),
});
export type WorkerEnv = z.output<typeof WorkerEnv>;

export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
export const GRANTS_PATH = join(REPO_ROOT, "data", "grants.json");
