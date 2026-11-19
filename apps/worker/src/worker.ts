/**
 * pnpm worker — Temporal-воркер: виконує searchWorkflow і activities Scout.
 * Від чийого імені: делегований токен від STS за ГРАНТОМ (data/grants.json), а не за логіном —
 * людини поруч немає. Грант читається на кожен запит: відкликали — наступний крок уже без доступу.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { NativeConnection, Worker } from "@temporalio/worker";
import { type JWK, importJWK } from "jose";
import { gatewayModel } from "../../runtime/src/gateway-model.ts";
import { delegationHeaders } from "../../runtime/src/session.ts";
import { loadAgentSpec } from "../../runtime/src/spec.ts";
import { createSts, userFromGrant } from "../../runtime/src/sts.ts";
import { createActivities } from "./activities.ts";
import { GRANTS_PATH, REPO_ROOT, WorkerEnv } from "./config.ts";
import { GrantStore } from "./grants.ts";
import type { ScoutDeps } from "./scout.ts";

const env = WorkerEnv.parse(process.env);
const spec = loadAgentSpec(join(REPO_ROOT, "agents", "scout.yaml"));
const agent = `agent:${spec.id}@${spec.version}`;
const grants = new GrantStore(GRANTS_PATH);

async function buildAuthHeaders(): Promise<ScoutDeps["authHeaders"]> {
  if (env.AUTH_MODE === "debug") {
    console.warn("⚠  AUTH_MODE=debug: заголовки x-debug-*, без токенів і без перевірки грантів");
    return async (_server, run) => delegationHeaders(run.employeeId, spec);
  }
  const keyPath = isAbsolute(env.RUNTIME_STS_KEY_PATH) ? env.RUNTIME_STS_KEY_PATH : join(REPO_ROOT, env.RUNTIME_STS_KEY_PATH);
  const jwk = JSON.parse(readFileSync(keyPath, "utf8")) as JWK & { kid: string };
  const sts = createSts({ privateKey: (await importJWK(jwk, "ES256")) as Parameters<typeof createSts>[0]["privateKey"], kid: jwk.kid });
  return async (server, run) => {
    const grant = grants.get(run.employeeId, spec.id);
    // Гранту немає — повтор не допоможе: це рішення людини, а не збій мережі.
    if (!grant) throw ApplicationFailure.nonRetryable(`Немає гранту ${run.employeeId} → ${spec.id}`, "grant_missing");
    const user = userFromGrant(grant, spec);
    return { authorization: `Bearer ${await sts.mint(user, { agent, audience: `mcp-${server}`, runId: run.runKey })}` };
  };
}

const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });
const worker = await Worker.create({
  connection,
  taskQueue: env.TASK_QUEUE,
  workflowsPath: join(import.meta.dirname, "workflows.ts"),
  activities: createActivities({
    spec,
    model: gatewayModel({ baseUrl: env.GATEWAY_URL, apiKey: env.RUNTIME_GATEWAY_KEY, model: spec.model.primary, agentId: `${spec.id}@${spec.version}`, dataClass: spec.dataClass }),
    servers: { listings: env.LISTINGS_URL, relocation: env.RELOCATION_URL },
    now: () => env.RUNTIME_NOW ?? new Date().toISOString(),
    authHeaders: await buildAuthHeaders(),
  }),
});
console.log(`worker: ${env.TEMPORAL_ADDRESS}, черга ${env.TASK_QUEUE}, агент ${agent}, pid ${process.pid}`);
await worker.run();
