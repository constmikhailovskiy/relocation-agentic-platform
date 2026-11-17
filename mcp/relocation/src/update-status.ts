import { InvalidTransitionError, SearchStatus, assertTransition } from "@reloc/shared";
import { z } from "zod";
import { type Ctx, RelocationError, assertOpen, authorizeSearch, invalidInput } from "./context.ts";

export const UpdateStatusInput = z.object({
  to: SearchStatus,
  reason: z.string().trim().min(1).max(500).describe("Чому змінюється статус — піде в історію статусів"),
});

/**
 * update_status(search_id, to, reason).
 *  - права: перехід у secured — окрема дія mark_secured (лише relocation-менеджер);
 *  - стан: кінцевий статус не змінюється;
 *  - перехід: лише з TRANSITIONS (packages/shared/src/status.ts). Роль не обходить діаграму.
 */
export function updateStatus(ctx: Ctx, searchId: string, to: unknown, reason: unknown): { searchId: string; from: SearchStatus; to: SearchStatus } {
  const parsed = UpdateStatusInput.safeParse({ to, reason });
  // `to` потрібен для вибору дії ще до перевірки прав. Невалідний `to` → звичайна дія update_status,
  // щоб чужий усе одно отримав not_found, а не invalid_input.
  const action = parsed.success && parsed.data.to === "secured" ? "search.mark_secured" : "search.update_status";

  const { search } = authorizeSearch(ctx, "update_status", action, ctx.store.searchById(searchId), searchId);
  assertOpen(search);
  if (!parsed.success) throw invalidInput(parsed.error);

  try {
    assertTransition(search.status, parsed.data.to);
  } catch (e) {
    // Доменна помилка зі shared → помилка інструмента. Текст уже написаний для моделі: перелічує дозволені переходи.
    if (e instanceof InvalidTransitionError) throw new RelocationError("invalid_transition", e.message);
    throw e;
  }

  ctx.store.changeStatus(search.id, {
    from: search.status,
    to: parsed.data.to,
    reason: parsed.data.reason,
    by: ctx.principal.sub,
    ...(ctx.principal.act && { agent: ctx.principal.act.sub }),
    at: ctx.now(),
  });
  return { searchId: search.id, from: search.status, to: parsed.data.to };
}
