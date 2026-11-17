import { z } from "zod";
import { type Ctx, RelocationError, actorFor, assertOpen, authorizeSearch, canRead, invalidInput, writeAudit } from "./context.ts";

export interface BudgetExceptionView {
  approvalId: string;
  status: "pending" | "approved" | "rejected";
  amountUah: number;
  capUah: number;
}

const Input = z.object({
  amountUah: z.number().int().positive().max(200_000),
  reason: z.string().trim().min(1).max(500),
});

/**
 * request_budget_exception(search_id, amount, reason) — ІНСТРУМЕНТ. Створює approval зі статусом pending.
 * Поки є невирішений запит цього ж користувача, повтор повертає його: агент у циклі не завалить HR однаковими запитами.
 */
export function requestBudgetException(ctx: Ctx, searchId: string, amountUah: unknown, reason: unknown): BudgetExceptionView {
  const { search } = authorizeSearch(ctx, "request_budget_exception", "search.request_budget_exception", ctx.store.searchById(searchId), searchId);
  assertOpen(search);

  const parsed = Input.safeParse({ amountUah, reason });
  if (!parsed.success) throw invalidInput(parsed.error);
  if (parsed.data.amountUah <= search.companyCapUah) {
    throw new RelocationError("invalid_input", `Виняток не потрібен: ${parsed.data.amountUah} грн у межах ліміту ${search.companyCapUah} грн. Використай set_criteria.`);
  }

  // Лише СВІЙ pending: інакше запит Тараса повернувся б Олені, а схвалити його Тарас не може (SoD).
  const existing = ctx.store.findApproval(
    (a) => a.kind === "budget_exception" && a.searchId === search.id && a.requestedBy === ctx.principal.sub && a.status === "pending",
  );
  const approval =
    existing ??
    ctx.store.addApproval({
      kind: "budget_exception",
      searchId: search.id,
      requestedBy: ctx.principal.sub,
      ...(ctx.principal.act && { agent: ctx.principal.act.sub }),
      amountUah: parsed.data.amountUah,
      reason: parsed.data.reason,
      status: "pending",
    });
  if (approval.kind !== "budget_exception") throw new Error("unreachable");
  return { approvalId: approval.id, status: approval.status, amountUah: approval.amountUah, capUah: search.companyCapUah };
}

/**
 * Рішення людини в UI. НЕ інструмент MCP — у агента такої можливості немає взагалі.
 * Три окремі бар'єри (кожен має свій тест):
 *  - не через агента (`act`): навіть якщо колись хтось помилково виставить цю функцію інструментом;
 *  - лише relocation-менеджер;
 *  - не щодо власного запиту — розділення обов'язків (Тарас не схвалює сам собі).
 */
export function decideBudgetException(ctx: Ctx, approvalId: string, decision: "approved" | "rejected"): BudgetExceptionView {
  const ACTION = "relocation.decide_budget_exception" as const;
  const approval = ctx.store.approval(approvalId);
  const search = approval && ctx.store.searchById(approval.searchId);
  const deny = (code: "not_found" | "forbidden", reason: string, message: string): never => {
    writeAudit(ctx, ACTION, approvalId, "deny", reason);
    throw new RelocationError(code, message);
  };

  if (!approval || approval.kind !== "budget_exception" || !search || !canRead(ctx, search)) return deny("not_found", "not_found", "Запит не знайдено");
  if (ctx.principal.act) return deny("forbidden", "agent_cannot_approve", "Схвалює лише людина, не агент");
  if (!actorFor(ctx).roles.includes("relocation_manager")) return deny("forbidden", "requires_relocation_manager", "Схвалює relocation-менеджер");
  if (approval.requestedBy === ctx.principal.sub) return deny("forbidden", "separation_of_duties", "Не можна вирішувати власний запит");
  if (approval.status !== "pending") throw new RelocationError("already_decided", `Запит уже ${approval.status}`);

  const done = ctx.store.decide(approval.id, decision, ctx.principal.sub);
  if (decision === "approved") ctx.store.raiseCap(search.id, approval.amountUah);
  writeAudit(ctx, ACTION, approvalId, "allow", decision);
  if (done.kind !== "budget_exception") throw new Error("unreachable");
  return { approvalId: done.id, status: done.status, amountUah: done.amountUah, capUah: ctx.store.searchById(search.id)?.companyCapUah ?? search.companyCapUah };
}
