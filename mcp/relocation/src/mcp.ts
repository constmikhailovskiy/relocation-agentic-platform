import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Criteria, type Principal, SearchStatus, ShortlistItem } from "@reloc/shared";
import { z } from "zod";
import { requestBudgetException } from "./budget-exception.ts";
import { type AuditEvent, type Ctx, RelocationError } from "./context.ts";
import { getSearch } from "./get-search.ts";
import { notifyEmployee } from "./notify-employee.ts";
import { requestViewing } from "./request-viewing.ts";
import { saveShortlist } from "./save-shortlist.ts";
import { setCriteria } from "./set-criteria.ts";
import type { RelocationStore } from "./store.ts";
import { updateStatus } from "./update-status.ts";

/** Усе, що потрібно серверу ззовні. Стор — один на процес; McpServer — новий на кожен запит. */
export interface RelocationDeps {
  store: RelocationStore;
  now: () => string;
  audit?: (event: AuditEvent) => void;
  /** Куди писати справжні деталі неочікуваних помилок (клієнту вони не йдуть). */
  logError?: (tool: string, error: unknown) => void;
}

function ok(data: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
}

/** Помилка лише текстом, без structuredContent — та сама причина, що в listings (outputSchema перевіряється і в помилках). */
function fail(error: { code: string; message: string; retryable: boolean }): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
}

/**
 * На відміну від listings, аудит тут пишеться НЕ в обгортці, а в домені (authorizeSearch):
 * подія аудиту має містити рішення (allow / allow_partial / deny), а його знає лише authorize.
 */
async function handle(deps: RelocationDeps, tool: string, run: () => object): Promise<CallToolResult> {
  try {
    return ok(run());
  } catch (e) {
    if (e instanceof RelocationError) return fail({ code: e.code, message: e.message, retryable: e.retryable });
    (deps.logError ?? ((t, err) => console.error(`[relocation] ${t}:`, err)))(tool, e);
    return fail({ code: "internal_error", message: "Внутрішня помилка сервісу relocation", retryable: false });
  }
}

const SEARCH_ID = z.string().min(1).max(64).describe("Ідентифікатор пошуку, наприклад s-olena (є в get_search)");
const EMPLOYEE_ID = z.string().min(1).max(64).describe("Ідентифікатор працівника");

/**
 * Схеми входу — strictObject: зайве поле (наприклад `to` у notify_employee) — помилка ще в SDK,
 * а модель бачить у JSON Schema `additionalProperties: false`. Імена полів — snake_case, як у контракті з case.md.
 */
const Inputs = {
  get_search: z.strictObject({ employee_id: EMPLOYEE_ID }),
  set_criteria: z.strictObject({ employee_id: EMPLOYEE_ID, criteria: Criteria }),
  save_shortlist: z.strictObject({
    search_id: SEARCH_ID,
    items: z.array(z.strictObject({ listing_key: ShortlistItem.shape.listingKey, reason: ShortlistItem.shape.reason })).min(1).max(20),
  }),
  update_status: z.strictObject({
    search_id: SEARCH_ID,
    to: SearchStatus.describe("Новий статус. Дозволені переходи перевіряє сервер"),
    reason: z.string().min(1).max(500),
  }),
  request_viewing: z.strictObject({
    search_id: SEARCH_ID,
    listing_key: z.string().min(1).max(64).describe("Ключ оголошення з шортлиста"),
    slots: z.array(z.iso.datetime()).min(1).max(3).describe("1–3 варіанти часу, ISO 8601, у майбутньому"),
  }),
  request_budget_exception: z.strictObject({
    search_id: SEARCH_ID,
    amount_uah: z.number().int().positive().max(200_000),
    reason: z.string().min(1).max(500),
  }),
  notify_employee: z.strictObject({ search_id: SEARCH_ID, message: z.string().min(1).max(1000) }),
};

/** Схеми виходу. У get_search усе, крім id/employeeId/status, необов'язкове: керівник отримує урізане представлення. */
const Outputs = {
  get_search: z.object({
    id: z.string(),
    employeeId: z.string(),
    status: SearchStatus,
    criteria: Criteria.optional(),
    companyCapUah: z.number().optional(),
    shortlist: z.array(ShortlistItem).optional(),
  }),
  set_criteria: z.object({ searchId: z.string(), criteria: Criteria }),
  save_shortlist: z.object({ added: z.array(z.string()), alreadyPresent: z.array(z.string()), total: z.number() }),
  update_status: z.object({ searchId: z.string(), from: SearchStatus, to: SearchStatus }),
  request_viewing: z.object({
    approvalId: z.string(),
    status: z.enum(["pending_confirmation", "confirmed"]),
    listingKey: z.string(),
    slots: z.array(z.string()),
    argsHash: z.string(),
    expiresAt: z.string(),
  }),
  request_budget_exception: z.object({
    approvalId: z.string(),
    status: z.enum(["pending", "approved", "rejected"]),
    amountUah: z.number(),
    capUah: z.number(),
  }),
  notify_employee: z.object({ sent: z.literal(true), to: z.string() }),
};

/**
 * MCP-сервер relocation. Новий екземпляр на кожен запит: principal «вшитий» у ctx через замикання.
 * Права, стан і бізнес-правила — у доменних функціях; тут лише переклад MCP ↔ домен.
 */
export function createRelocationServer(deps: RelocationDeps, principal: Principal): McpServer {
  const server = new McpServer({ name: "relocation", version: "0.1.0" });
  const ctx: Ctx = { store: deps.store, principal, now: deps.now, ...(deps.audit && { audit: deps.audit }) };

  server.registerTool(
    "get_search",
    {
      description:
        "Пошук житла працівника: статус, критерії, ліміт компанії, шортлист. Що саме повернеться, залежить від прав користувача: " +
        "керівнику — лише статус. Немає доступу або пошуку — not_found.",
      inputSchema: Inputs.get_search,
      outputSchema: Outputs.get_search,
      annotations: { readOnlyHint: true },
    },
    ({ employee_id }) => handle(deps, "get_search", () => getSearch(ctx, employee_id)),
  );

  server.registerTool(
    "set_criteria",
    {
      description:
        "Зберегти критерії пошуку. Бюджет понад ліміт компанії відхиляється (over_cap) — тоді запропонуй request_budget_exception.",
      inputSchema: Inputs.set_criteria,
      outputSchema: Outputs.set_criteria,
    },
    ({ employee_id, criteria }) => handle(deps, "set_criteria", () => setCriteria(ctx, employee_id, criteria)),
  );

  server.registerTool(
    "save_shortlist",
    {
      description: "Додати оголошення в шортлист. Ідемпотентно: повтор не створює дублів, відповідь каже, що вже було.",
      inputSchema: Inputs.save_shortlist,
      outputSchema: Outputs.save_shortlist,
      annotations: { idempotentHint: true },
    },
    ({ search_id, items }) =>
      handle(deps, "save_shortlist", () =>
        // `...(cond && {...})` — додати reason лише якщо він є.
        saveShortlist(ctx, search_id, items.map((i) => ({ listingKey: i.listing_key, ...(i.reason !== undefined && { reason: i.reason }) }))),
      ),
  );

  server.registerTool(
    "update_status",
    {
      description:
        "Змінити статус пошуку. Дозволені лише переходи з діаграми станів; помилка invalid_transition перелічує дозволені. " +
        "Перехід у secured робить лише relocation-менеджер.",
      inputSchema: Inputs.update_status,
      outputSchema: Outputs.update_status,
    },
    ({ search_id, to, reason }) => handle(deps, "update_status", () => updateStatus(ctx, search_id, to, reason)),
  );

  server.registerTool(
    "request_viewing",
    {
      description:
        "Попросити перегляд квартири з шортлиста. Орендодавцю НІЧОГО не надсилається: створюється запит pending_confirmation, " +
        "який користувач має підтвердити сам. Покажи користувачу квартиру і слоти саме в такому вигляді.",
      inputSchema: Inputs.request_viewing,
      outputSchema: Outputs.request_viewing,
    },
    ({ search_id, listing_key, slots }) => handle(deps, "request_viewing", () => requestViewing(ctx, search_id, listing_key, slots)),
  );

  server.registerTool(
    "request_budget_exception",
    {
      description: "Попросити виняток з ліміту бюджету. Створює запит на схвалення людиною (HR); схвалити його агент не може.",
      inputSchema: Inputs.request_budget_exception,
      outputSchema: Outputs.request_budget_exception,
    },
    ({ search_id, amount_uah, reason }) =>
      handle(deps, "request_budget_exception", () => requestBudgetException(ctx, search_id, amount_uah, reason)),
  );

  server.registerTool(
    "notify_employee",
    {
      description: "Надіслати повідомлення власнику пошуку. Адресата обрати не можна — лише власник.",
      inputSchema: Inputs.notify_employee,
      outputSchema: Outputs.notify_employee,
    },
    // Другий аргумент обробника — `extra`: тут є `_meta` із запиту. Ключ ідемпотентності кладе туди runtime,
    // тож модель його не бачить і не може ні забути, ні підробити.
    ({ search_id, message }, extra) =>
      handle(deps, "notify_employee", () =>
        notifyEmployee(ctx, search_id, { message }, { ...(extra._meta?.idempotencyKey !== undefined && { idempotencyKey: extra._meta.idempotencyKey }) }),
      ),
  );

  return server;
}
