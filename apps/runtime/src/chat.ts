import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { AgentSpec } from "@reloc/shared";
import { type JWK, createRemoteJWKSet, importJWK } from "jose";
import { z } from "zod";
import { RuntimeEnv, parseChatArgs } from "./config.ts";
import { gatewayModel } from "./gateway-model.ts";
import { passwordLogin } from "./idp-login.ts";
import { type ViewingShown, viewingGuard } from "./hitl.ts";
import type { RunOutcome, TraceEvent } from "./loop.ts";
import { connectTools } from "./mcp-tools.ts";
import { relocationConfirmer } from "./relocation-client.ts";
import { createSession, delegationHeaders } from "./session.ts";
import { loadAgentSpec } from "./spec.ts";
import { assertAudience, createSts, delegatedAuthHeaders, userVerifier } from "./sts.ts";

/**
 * CLI-чат: pnpm chat --as olena [--model mock|haiku] [--agent agents/concierge.yaml]
 * Тут лише «клей»: термінал, друк трейсу, питання y/n. Уся логіка — у протестованих модулях.
 */

// ---------- Ввід: однаково для терміналу і для `printf '...' | pnpm chat` ----------

/**
 * Черга рядків замість rl.question: при вводі з pipe рядки приходять раніше, ніж ми питаємо,
 * і rl.question їх би загубив. EOF (Ctrl+D, кінець pipe) → null.
 */
function lineReader() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queue: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  let closed = false;
  rl.on("line", (line) => {
    if (waiting) {
      const w = waiting;
      waiting = undefined;
      w(line);
    } else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    waiting?.(null);
  });
  return {
    async ask(prompt: string): Promise<string | null> {
      process.stdout.write(prompt);
      const line = queue.length > 0 ? queue.shift()! : closed ? null : await new Promise<string | null>((r) => (waiting = r));
      // Ввід з pipe не відображається в терміналі — друкуємо його, щоб транскрипт читався.
      if (!process.stdin.isTTY) process.stdout.write(`${line ?? "<EOF>"}\n`);
      return line;
    },
    close: () => rl.close(),
  };
}

// ---------- Вивід ----------

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const usd = (n: number) => `$${n.toFixed(4)}`;

/** Трейс — у stderr: його можна відрізати (`2>/dev/null`), а розмова лишиться. */
function printTrace(e: TraceEvent): void {
  const line =
    e.type === "model"
      ? `· крок ${e.step} · ${e.model} · ${e.inputTokens}→${e.outputTokens} ток · ${usd(e.costUsd)} · ${e.ms} мс${e.toolCalls ? ` · викликів: ${e.toolCalls}` : ""}`
      : e.type === "tool"
        ? `  ↳ ${e.tool} ${e.ok ? "✓" : `✗ ${e.error}`} · ${e.ms} мс${e.detail ? ` · ${e.detail}` : ""}`
        : `· кінець: ${e.outcome} · кроків: ${e.steps} · ${usd(e.costUsd)}`;
  process.stderr.write(`${dim(line)}\n`);
}

/** Слот так, як його зрозуміє людина у Львові, плюс точне ISO-значення, яке піде на сервер. */
const kyiv = (iso: string) =>
  `${new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", dateStyle: "medium", timeStyle: "short" })} (Київ) — ${iso}`;

function showViewing(s: ViewingShown): string {
  return [
    "",
    "⚠  Агент просить перегляд квартири. Без твого «так» нічого не станеться.",
    `   пошук:    ${s.searchId}`,
    `   квартира: ${s.listingKey}`,
    ...s.slots.map((slot, i) => `   слот ${i + 1}:   ${kyiv(slot)}`),
    "",
  ].join("\n");
}

function printOutcome(o: RunOutcome): void {
  if (o.kind === "answer") console.log(`\nагент> ${o.text}\n`);
  else if (o.kind === "max_steps") console.log(`\n[зупинено: ліміт кроків (${o.steps}). Уточни запит або продовж розмову.]\n`);
  else console.log(`\n[зупинено: ${o.message}]\n`);
}

// ---------- Хто людина ----------

interface UserAuth {
  sub: string;
  mode: string;
  agentHeaders: (current: { runId: string }) => (server: string) => Promise<Record<string, string>>;
  humanHeaders: () => Promise<Record<string, string>>;
}

/**
 * jwt: логін у Keycloak → runtime САМ перевіряє токен (підпис, iss, aud) → роль в audience агента →
 *      делеговані токени від STS на кожен запит; підтвердження — токеном людини.
 * debug: заглушка x-debug-* (сервери теж мають бути з AUTH_MODE=debug). Так працювали етапи 2–3.
 */
async function authenticateUser(env: RuntimeEnv, repoRoot: string, username: string, spec: AgentSpec, input: ReturnType<typeof lineReader>): Promise<UserAuth> {
  if (env.AUTH_MODE === "debug") {
    console.warn(dim("⚠  AUTH_MODE=debug: ніякої автентифікації, principal із заголовків x-debug-*"));
    return {
      sub: username,
      mode: "debug",
      agentHeaders: () => async () => delegationHeaders(username, spec),
      humanHeaders: async () => ({ "x-debug-sub": username }),
    };
  }
  const password = env.DEMO_PASSWORD ?? (await input.ask(`пароль ${username} (пісочниця Keycloak): `));
  if (!password) throw new Error("Без пароля входу немає");
  const token = await passwordLogin({ issuer: env.IDP_ISSUER, clientId: env.IDP_CLIENT_ID, username, password });
  const user = await userVerifier({
    issuer: env.IDP_ISSUER,
    audience: env.IDP_CLIENT_ID,
    keys: createRemoteJWKSet(new URL(`${env.IDP_ISSUER}/protocol/openid-connect/certs`)),
  })(token);
  assertAudience(spec, user);
  const keyPath = isAbsolute(env.RUNTIME_STS_KEY_PATH) ? env.RUNTIME_STS_KEY_PATH : join(repoRoot, env.RUNTIME_STS_KEY_PATH);
  const jwk = JSON.parse(readFileSync(keyPath, "utf8")) as JWK & { kid: string };
  const sts = createSts({ privateKey: await importJWK(jwk, "ES256") as Parameters<typeof createSts>[0]["privateKey"], kid: jwk.kid });
  return {
    sub: user.sub,
    mode: `jwt, ролі: ${user.roles.join(", ")}`,
    agentHeaders: (current) => delegatedAuthHeaders(sts, user, `agent:${spec.id}@${spec.version}`, current),
    humanHeaders: async () => ({ authorization: `Bearer ${token}` }),
  };
}

// ---------- Збірка ----------

async function main(): Promise<void> {
  const args = parseChatArgs(process.argv.slice(2));
  const envParsed = RuntimeEnv.safeParse(process.env);
  if (!envParsed.success) {
    console.error(`Невалідне середовище runtime:\n${z.prettifyError(envParsed.error)}\nПідказка: RUNTIME_GATEWAY_KEY=dev-runtime-key у .env`);
    process.exit(1);
  }
  const env = envParsed.data;
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const spec = loadAgentSpec(args.agent ? resolve(process.cwd(), args.agent) : join(repoRoot, "agents", "concierge.yaml"));
  const modelAlias = args.model ?? spec.model.primary;
  const now = env.RUNTIME_NOW ?? new Date().toISOString();

  const input = lineReader();
  const auth = await authenticateUser(env, repoRoot, args.sub, spec, input);

  // Поточний хід: сесія оновлює runId, а STS кладе його в кожен делегований токен.
  const current = { runId: "" };
  const tools = await connectTools({
    servers: { listings: env.LISTINGS_URL, relocation: env.RELOCATION_URL },
    allowlist: spec.tools,
    authHeaders: auth.agentHeaders(current),
  });
  const guards = new Map([
    [
      "relocation.request_viewing",
      viewingGuard({
        ask: async (shown) => {
          console.log(showViewing(shown));
          const a = await input.ask("Підтвердити? [y/N] ");
          return a !== null && /^(y|yes|т|так)$/i.test(a.trim());
        },
        // Підтвердження — заголовками ЛЮДИНИ (токен IdP), не агента.
        confirm: relocationConfirmer({ baseUrl: new URL(env.RELOCATION_URL).origin, authHeaders: auth.humanHeaders }),
      }),
    ],
  ]);
  const session = createSession({
    spec,
    sub: auth.sub,
    now,
    newRunId: () => (current.runId = randomUUID()),
    model: gatewayModel({ baseUrl: env.GATEWAY_URL, apiKey: env.RUNTIME_GATEWAY_KEY, model: modelAlias, agentId: `${spec.id}@${spec.version}`, dataClass: spec.dataClass }),
    tools,
    guards,
    onTrace: printTrace,
  });

  console.log(`${spec.id}@${spec.version} · модель ${modelAlias} · від імені ${auth.sub} (${auth.mode}) · зараз ${now}`);
  console.log(`інструменти: ${tools.defs.map((d) => d.function.name).join(", ")}`);
  console.log("Порожній рядок або /exit — вихід.\n");

  let total = 0;
  try {
    for (;;) {
      const line = await input.ask("ти> ");
      if (line === null || line.trim() === "" || line.trim() === "/exit") break;
      const out = await session.send(line);
      total += out.costUsd;
      printOutcome(out);
    }
  } finally {
    input.close();
    await tools.close();
    console.log(dim(`разом за сесію: ${usd(total)}`));
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
