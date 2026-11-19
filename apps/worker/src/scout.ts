import type { AgentSpec } from "@reloc/shared";
import { ApplicationFailure } from "@temporalio/activity";
import type { TraceEvent } from "../../runtime/src/loop.ts";
import { connectTools } from "../../runtime/src/mcp-tools.ts";
import type { CallModel } from "../../runtime/src/model.ts";
import { createSession } from "../../runtime/src/session.ts";
import type { ToolSet } from "../../runtime/src/tools.ts";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ScoutDeps {
  spec: AgentSpec;
  model: CallModel;
  /** Ім'я сервера → URL його /mcp. */
  servers: Record<string, string>;
  /** «Зараз» для системного промпту. */
  now: () => string;
  /** Заголовки автентифікації на КОЖЕН запит: делегований токен від імені працівника (грант), act = scout. */
  authHeaders: (server: string, run: { runKey: string; employeeId: string }) => Promise<Record<string, string>>;
  fetch?: Fetch;
  /** Context.heartbeat() у Temporal: без серцебиття смерть воркера видно лише після startToCloseTimeout. */
  heartbeat?: () => void;
}

export interface ScoutInput {
  searchId: string;
  employeeId: string;
  /** `${searchId}:${iteration}` — однаковий для всіх повторів однієї ітерації і різний для різних днів. */
  runKey: string;
}

export interface ScoutResult {
  newItems: number;
  added: string[];
  notified: boolean;
}

/**
 * Інструменти, якими користується КОД activity (не модель): прочитати шортлист і надіслати лист.
 * Окремий набір: у моделі цих повноважень немає взагалі (див. agents/scout.yaml).
 */
async function codeTools(d: ScoutDeps, run: { runKey: string; employeeId: string }): Promise<ToolSet> {
  return connectTools({
    servers: { relocation: d.servers.relocation! },
    allowlist: ["relocation.get_search", "relocation.notify_employee"],
    authHeaders: (server) => d.authHeaders(server, run),
    ...(d.fetch && { fetch: d.fetch }),
  });
}

async function readShortlist(tools: ToolSet, employeeId: string, runKey: string): Promise<string[]> {
  const r = await tools.get("relocation__get_search")!.call({ employee_id: employeeId }, { idempotencyKey: `${runKey}:read` });
  // Сервер недоступний чи відмовив — ретраїна аварія, а не «шортлист порожній».
  if (r.isError) throw ApplicationFailure.retryable(`get_search: ${r.text}`, "relocation_unavailable");
  const view = JSON.parse(r.text) as { shortlist?: { listingKey: string }[] };
  return (view.shortlist ?? []).map((i) => i.listingKey);
}

/**
 * Activity 1: знімок шортлиста ДО запуску агента. Її результат Temporal записує в історію, тож повтор runScout
 * після смерті воркера порівнює з тим самим знімком — і бачить нове, навіть якщо модель отримала alreadyPresent.
 */
export async function snapshotShortlist(d: ScoutDeps, input: { searchId: string; employeeId: string; runKey?: string }): Promise<string[]> {
  const tools = await codeTools(d, { runKey: input.runKey ?? "snapshot", employeeId: input.employeeId });
  try {
    return await readShortlist(tools, input.employeeId, input.runKey ?? "snapshot");
  } finally {
    await tools.close();
  }
}

/**
 * Activity 2: один щоденний запуск Scout.
 *  1. Агент (модель) шукає й зберігає нове в шортлист — save_shortlist ідемпотентний за ключем оголошення.
 *  2. Код рахує нове як різницю з `before` (знімок з історії Temporal), а не зі слів моделі.
 *  3. Код надсилає лист з ключем `${runKey}:notify`: повтор ітерації не дасть другого листа, будь-який
 *     інший день — дасть.
 * Помилки для Temporal: збій інструментів — ретраїться; вичерпаний бюджет чи ліміт кроків — ні.
 */
export async function runScout(d: ScoutDeps, input: ScoutInput & { before: string[] }): Promise<ScoutResult> {
  const { spec } = d;
  let modelTools: ToolSet | undefined;
  let tools: ToolSet | undefined;
  try {
    try {
      modelTools = await connectTools({
        servers: d.servers,
        allowlist: spec.tools,
        authHeaders: (server) => d.authHeaders(server, input),
        ...(d.fetch && { fetch: d.fetch }),
      });
      tools = await codeTools(d, input);
    } catch (e) {
      // Уже класифікована помилка (напр. grant_missing від authHeaders) — як є; решта — збій мережі, retryable.
      if (e instanceof ApplicationFailure) throw e;
      throw ApplicationFailure.retryable(`MCP недоступний: ${(e as Error).message}`, "mcp_unavailable");
    }

    const toolFailures: string[] = [];
    const onTrace = (e: TraceEvent) => {
      d.heartbeat?.();
      if (e.type === "tool" && e.error === "tool_failed") toolFailures.push(e.tool);
    };
    // runId = runKey: усі повтори однієї ітерації — один «запуск» для бюджету gateway і аудиту.
    const session = createSession({ spec, sub: input.employeeId, now: d.now(), model: d.model, tools: modelTools, guards: new Map(), newRunId: () => input.runKey, onTrace });
    const out = await session.send(`Щоденний запуск для пошуку ${input.searchId} (employee_id: ${input.employeeId}). Знайди нові варіанти.`);

    if (out.kind === "budget_exceeded") throw ApplicationFailure.nonRetryable(out.message, "budget_exceeded");
    if (out.kind === "max_steps") throw ApplicationFailure.nonRetryable(`Scout не вклався в ${out.steps} кроків`, "max_steps");
    if (toolFailures.length) throw ApplicationFailure.retryable(`Інструменти недоступні: ${toolFailures.join(", ")}`, "tool_failed");

    const after = await readShortlist(tools, input.employeeId, input.runKey);
    const added = after.filter((k) => !input.before.includes(k));
    if (added.length === 0) return { newItems: 0, added, notified: false };

    const message = (out.text.trim() || `Нові варіанти в шортлисті: ${added.join(", ")}`).slice(0, 1000);
    const sent = await tools.get("relocation__notify_employee")!.call({ search_id: input.searchId, message }, { idempotencyKey: `${input.runKey}:notify` });
    if (sent.isError) throw ApplicationFailure.retryable(`notify_employee: ${sent.text}`, "notify_failed");
    return { newItems: added.length, added, notified: true };
  } finally {
    await modelTools?.close();
    await tools?.close();
  }
}

/**
 * Activity 3: «3 дні без нового» → needs_attention. Лише зі статусу searching (інші переходи заборонені
 * TRANSITIONS). Інший статус — не помилка: просто нічого не міняємо, інакше 5 ретраїв і мертвий workflow.
 */
export async function markNeedsAttention(d: ScoutDeps, input: ScoutInput & { reason: string }): Promise<{ changed: boolean }> {
  const tools = await connectTools({
    servers: { relocation: d.servers.relocation! },
    allowlist: ["relocation.get_search", "relocation.update_status"],
    authHeaders: (server) => d.authHeaders(server, input),
    ...(d.fetch && { fetch: d.fetch }),
  });
  try {
    const view = await tools.get("relocation__get_search")!.call({ employee_id: input.employeeId }, { idempotencyKey: `${input.runKey}:status-read` });
    if (view.isError) throw ApplicationFailure.retryable(`get_search: ${view.text}`, "relocation_unavailable");
    if ((JSON.parse(view.text) as { status: string }).status !== "searching") return { changed: false };
    const r = await tools.get("relocation__update_status")!.call(
      { search_id: input.searchId, to: "needs_attention", reason: input.reason },
      { idempotencyKey: `${input.runKey}:needs_attention` },
    );
    if (r.isError) throw ApplicationFailure.retryable(`update_status: ${r.text}`, "update_failed");
    return { changed: true };
  } finally {
    await tools.close();
  }
}
