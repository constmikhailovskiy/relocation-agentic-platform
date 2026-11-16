import { z } from "zod";

export const SearchStatus = z.enum([
  "draft",
  "searching",
  "shortlist_ready",
  "viewing_requested",
  "hr_approval",
  "secured",
  "needs_attention",
  "paused",
  "cancelled",
]);
export type SearchStatus = z.infer<typeof SearchStatus>;

/**
 * Єдине джерело правди про дозволені переходи (див. діаграму в документі).
 * `satisfies` перевіряє, що описані ВСІ статуси, і зберігає точні літеральні типи.
 */
export const TRANSITIONS = {
  draft: ["searching", "cancelled"],
  searching: ["shortlist_ready", "needs_attention", "paused", "cancelled"],
  shortlist_ready: ["viewing_requested", "searching", "paused", "cancelled"],
  viewing_requested: ["hr_approval", "shortlist_ready", "paused", "cancelled"],
  hr_approval: ["secured", "shortlist_ready", "cancelled"],
  needs_attention: ["searching", "paused", "cancelled"],
  paused: ["searching", "shortlist_ready", "cancelled"],
  secured: [],
  cancelled: [],
} as const satisfies Record<SearchStatus, readonly SearchStatus[]>;

export const TERMINAL: ReadonlySet<SearchStatus> = new Set(["secured", "cancelled"]);

export function canTransition(from: SearchStatus, to: SearchStatus): boolean {
  return (TRANSITIONS[from] as readonly SearchStatus[]).includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SearchStatus,
    readonly to: SearchStatus,
  ) {
    // Повідомлення написане так, щоб модель могла з нього виправитись.
    super(`Перехід ${from} → ${to} заборонено. Дозволені з ${from}: ${TRANSITIONS[from].join(", ") || "немає (кінцевий стан)"}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: SearchStatus, to: SearchStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
