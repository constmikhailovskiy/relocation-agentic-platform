import { type Action, type Actor, type Decision, type Principal, type Search, TERMINAL, authorize } from "@reloc/shared";
import type { z } from "zod";
import type { RelocationStore } from "./store.ts";

/** Подія аудиту. Пишеться ПІСЛЯ authorize, бо головне в ній — рішення і причина. */
export interface AuditEvent {
  action: `relocation.${string}`;
  actor: string;
  agent?: string;
  resource: string;
  decision: Decision["decision"];
  reason: string;
}

/** Контекст виклику інструмента: де дані, хто питає, куди писати аудит. */
export interface Ctx {
  store: RelocationStore;
  principal: Principal;
  /** Годинник сервера. «Зараз» ніколи не приходить від моделі. */
  now: () => string;
  audit?: (event: AuditEvent) => void;
}

export type RelocationErrorCode =
  | "not_found" | "forbidden" | "unknown_principal" | "invalid_input" | "over_cap" | "search_closed"
  | "invalid_transition"
  | "not_in_shortlist"
  | "wrong_status"
  | "args_mismatch"
  | "already_decided";

/** Помилка, яку побачить агент. Текст написаний для моделі: без деталей реалізації. */
export class RelocationError extends Error {
  constructor(
    readonly code: RelocationErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RelocationError";
  }
}

/** Один текст і для «немає такого пошуку», і для «немає доступу» — щоб відмова не видавала, що пошук існує. */
export const NOT_FOUND = "Пошук не знайдено";

/** Причини відмови → текст для моделі. Невідома причина — загальний текст (нові правила не ламають відповідь). */
const FORBIDDEN_HINTS: Record<string, string> = {
  requires_relocation_manager: "Цю дію виконує relocation-менеджер. Повідом користувача, що рішення за HR.",
  manager_read_only: "Керівник може лише бачити статус пошуку.",
};

/** Запис аудиту для дій поза authorizeSearch (рішення людей щодо approvals). */
export function writeAudit(ctx: Ctx, action: AuditEvent["action"], resource: string, decision: AuditEvent["decision"], reason: string): void {
  ctx.audit?.({ action, actor: ctx.principal.sub, ...(ctx.principal.act && { agent: ctx.principal.act.sub }), resource, decision, reason });
}

/** Principal → Actor: ролі беремо з довідника людей (етап 4 — з груп у JWT). */
export function actorFor(ctx: Ctx): Actor {
  const employee = ctx.store.employee(ctx.principal.sub);
  if (!employee) throw new RelocationError("unknown_principal", "Користувача не знайдено в довіднику");
  return { ...ctx.principal, roles: employee.roles };
}

/** Чи бачить principal цей пошук. Відмова тим, хто бачить, — forbidden; тим, хто ні, — not_found. */
export function canRead(ctx: Ctx, search: Search): boolean {
  const resource = { kind: "search" as const, ownerId: search.employeeId, ownerManagerId: ctx.store.employee(search.employeeId)?.managerId ?? null };
  return authorize(actorFor(ctx), "search.read", resource).decision !== "deny";
}

/**
 * Спільний для всіх інструментів крок: знайти власника пошуку → authorize → аудит.
 * Відмова:
 *  - хто пошуку НЕ бачить — not_found з тим самим текстом, що й відсутній пошук (без enumeration);
 *  - хто бачить, але дія не його — forbidden з поясненням: приховувати вже нічого, а модель має знати, що робити.
 */
export function authorizeSearch(
  ctx: Ctx,
  tool: string,
  action: Action,
  search: Search | undefined,
  resourceHint: string,
): { search: Search; fields: Decision["fields"] } {
  const actor = actorFor(ctx);
  // Пошуку немає: рішення «deny» лише для аудиту; authorize не викликаємо — нема що перевіряти.
  const decision: Decision = search
    ? authorize(actor, action, { kind: "search", ownerId: search.employeeId, ownerManagerId: ctx.store.employee(search.employeeId)?.managerId ?? null })
    : { decision: "deny", reason: "not_found", fields: [] };

  ctx.audit?.({
    action: `relocation.${tool}`,
    actor: actor.sub,
    // Spread з умовою: поле `agent` з'являється лише тоді, коли act є (exactOptionalPropertyTypes не пускає `agent: undefined`).
    ...(actor.act && { agent: actor.act.sub }),
    resource: search?.id ?? resourceHint,
    decision: decision.decision,
    reason: decision.reason,
  });

  if (!search) throw new RelocationError("not_found", NOT_FOUND);
  if (decision.decision === "deny") {
    if (!canRead(ctx, search)) throw new RelocationError("not_found", NOT_FOUND);
    throw new RelocationError("forbidden", `Немає прав на ${tool}. ${FORBIDDEN_HINTS[decision.reason] ?? ""}`.trim());
  }
  return { search, fields: decision.fields };
}

/** zod-помилка → текст для моделі: «шлях: що не так». За шляхом модель зрозуміє, яке поле виправити. */
export function invalidInput(error: z.ZodError): RelocationError {
  const issues = error.issues.map((i) => `${i.path.join(".") || "(корінь)"}: ${i.message}`);
  return new RelocationError("invalid_input", `Невалідні аргументи — ${issues.join("; ")}`);
}

/** Кінцевий статус (secured, cancelled) — пошук більше не змінюється жодним інструментом. */
export function assertOpen(search: Search): void {
  if (TERMINAL.has(search.status)) throw new RelocationError("search_closed", `Пошук у кінцевому статусі ${search.status}, змінювати його не можна`);
}
