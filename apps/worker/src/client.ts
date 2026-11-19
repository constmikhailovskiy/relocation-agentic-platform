/**
 * pnpm wf <команда>   (не `pnpm search` — це вбудована команда pnpm):
 *   start  --as olena --search s-olena [--tick "2 minutes"] [--max 3]  — логін у Keycloak → грант → старт workflow
 *   status --search s-olena                                            — query status
 *   pause|resume|criteria --search s-olena                             — сигнали
 *   close  --search s-olena [--reason cancelled]                       — сигнал closeSearch
 *   revoke --as olena                                                  — відкликати грант Scout
 */
import { parseArgs } from "node:util";
import { Client, Connection } from "@temporalio/client";
import { createRemoteJWKSet } from "jose";
import { passwordLogin } from "../../runtime/src/idp-login.ts";
import { userVerifier } from "../../runtime/src/sts.ts";
import { GRANTS_PATH, WorkerEnv } from "./config.ts";
import { GrantStore } from "./grants.ts";
import { type Duration, closeSearch, criteriaUpdated, searchWorkflow, setPaused, statusQuery } from "./workflows.ts";

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { as: { type: "string" }, search: { type: "string" }, tick: { type: "string", default: "24 hours" }, max: { type: "string" }, reason: { type: "string", default: "cancelled" } },
  strict: true,
});
const env = WorkerEnv.parse(process.env);
const client = new Client({ connection: await Connection.connect({ address: env.TEMPORAL_ADDRESS }) });
const wfId = () => {
  if (!values.search) throw new Error("Потрібен --search <id>, напр. s-olena");
  return `search-${values.search}`;
};

switch (cmd) {
  case "start": {
    if (!values.as) throw new Error("Потрібен --as <користувач>: грант видає людина, а не воркер");
    if (env.AUTH_MODE === "jwt") {
      // Людина поруч: перевіряємо її токен і записуємо делегування для Scout.
      const password = env.DEMO_PASSWORD ?? (() => { throw new Error("DEMO_PASSWORD не задано"); })();
      const token = await passwordLogin({ issuer: env.IDP_ISSUER, clientId: env.IDP_CLIENT_ID, username: values.as, password });
      const user = await userVerifier({ issuer: env.IDP_ISSUER, audience: env.IDP_CLIENT_ID, keys: createRemoteJWKSet(new URL(`${env.IDP_ISSUER}/protocol/openid-connect/certs`)) })(token);
      new GrantStore(GRANTS_PATH).put({ sub: user.sub, roles: [...user.roles], agentId: "scout", grantedAt: new Date().toISOString() });
      console.log(`грант: ${user.sub} → scout (${GRANTS_PATH})`);
    }
    const h = await client.workflow.start(searchWorkflow, {
      taskQueue: env.TASK_QUEUE,
      workflowId: wfId(),
      args: [{ searchId: values.search!, employeeId: values.as, tick: values.tick as Duration, ...(values.max && { maxIterations: Number(values.max) }) }],
    });
    console.log(`workflow ${h.workflowId} запущено (tick ${values.tick}${values.max ? `, максимум ${values.max} ітерацій` : ""})`);
    break;
  }
  case "status":
    console.log(JSON.stringify(await client.workflow.getHandle(wfId()).query(statusQuery), null, 2));
    break;
  case "pause":
  case "resume":
    await client.workflow.getHandle(wfId()).signal(setPaused, cmd === "pause");
    console.log(`${cmd}: ok`);
    break;
  case "criteria":
    await client.workflow.getHandle(wfId()).signal(criteriaUpdated);
    console.log("criteriaUpdated: ok");
    break;
  case "close":
    await client.workflow.getHandle(wfId()).signal(closeSearch, values.reason as "secured" | "cancelled");
    console.log(`close (${values.reason}): ok`);
    break;
  case "revoke":
    if (!values.as) throw new Error("Потрібен --as");
    new GrantStore(GRANTS_PATH).revoke(values.as, "scout");
    console.log(`грант ${values.as} → scout відкликано`);
    break;
  default:
    console.error("Команди: start | status | pause | resume | criteria | close | revoke");
    process.exit(1);
}
process.exit(0);
