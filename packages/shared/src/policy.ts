import type { Role } from "./people.ts";

/**
 * Хто викликає інструмент, як його бачить MCP-сервер.
 * `sub` — користувач, від імені якого діє агент. `act` — сам агент (делегування, RFC 8693).
 * На етапі 2 приходить із заголовків-заглушок, на етапі 4 — з перевіреного JWT.
 */
export interface Principal {
  sub: string;
  act?: { sub: string };
  /** Запуск агента (run_id з делегованого токена) — для аудиту «усі кроки запуску X». authorize його не читає. */
  runId?: string;
}

/** Principal + ролі, які сервер дістав із довідника людей (етап 4: з груп у JWT). */
export interface Actor extends Principal {
  roles: readonly Role[];
}

/**
 * Ресурс, над яким дія. Сервер сам знаходить власника і його керівника ДО виклику authorize:
 * так функція лишається чистою (без БД), і її легко тестувати таблицею.
 */
export interface SearchResource {
  kind: "search";
  ownerId: string;
  ownerManagerId: string | null;
}

export type Action =
  | "search.read"
  | "search.set_criteria"
  | "search.save_shortlist"
  | "search.update_status"
  /** Окрема дія для переходу hr_approval → secured: «схвалено» — рішення HR, а не працівника. */
  | "search.mark_secured"
  | "search.request_viewing"
  | "search.request_budget_exception"
  | "search.notify_employee";

/** Поля представлення пошуку. Проєкція будується З цього списку (allowlist), а не видаленням зайвого. */
export const SEARCH_FIELDS = ["id", "employeeId", "status", "criteria", "companyCapUah", "shortlist"] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** Що бачить керівник: є відношення manager_of, але бюджет і адреси — не його справа. */
const MANAGER_FIELDS: readonly SearchField[] = ["id", "employeeId", "status"];

export type Decision =
  | { decision: "allow" | "allow_partial"; reason: string; fields: readonly SearchField[] }
  | { decision: "deny"; reason: string; fields: readonly [] };

const deny = (reason: string): Decision => ({ decision: "deny", reason, fields: [] });

/**
 * Єдина точка рішення про доступ (PDP). Порядок правил важливий: перше, що спрацювало, — рішення.
 * `act` свідомо не читається: агент діє з правами користувача, не більше. Звуження до allowlist
 * інструментів агента робить runtime (AgentSpec.tools) — разом це дає «перетин прав».
 */
export function authorize(actor: Actor, action: Action, resource: SearchResource): Decision {
  // RBAC: роль сама по собі дає все.
  if (actor.roles.includes("relocation_manager")) return { decision: "allow", reason: "relocation_manager", fields: SEARCH_FIELDS };

  // Власник: усе над своїм пошуком (горизонтальний доступ закривається тут: sub, а не аргумент моделі),
  // крім рішень, які за процесом приймає HR.
  if (actor.sub === resource.ownerId) {
    return action === "search.mark_secured" ? deny("requires_relocation_manager") : { decision: "allow", reason: "owner", fields: SEARCH_FIELDS };
  }

  // ReBAC: роль hiring_manager нічого не дає без відношення manager_of до власника.
  if (actor.roles.includes("hiring_manager") && resource.ownerManagerId === actor.sub) {
    return action === "search.read" ? { decision: "allow_partial", reason: "manager_of", fields: MANAGER_FIELDS } : deny("manager_read_only");
  }

  return deny("no_relation");
}
