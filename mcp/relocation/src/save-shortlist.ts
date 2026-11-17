import { ShortlistItem } from "@reloc/shared";
import { z } from "zod";
import { type Ctx, assertOpen, authorizeSearch, invalidInput } from "./context.ts";

/** Не більше 20 за виклик: шортлист — це вибірка для людини, а не весь каталог. */
export const SaveShortlistItems = z.array(ShortlistItem).min(1).max(20);

/**
 * save_shortlist(search_id, items). Ідемпотентний: повтор того самого виклику дає той самий стан
 * і чесно каже, що вже було (`alreadyPresent`), — агенту не треба пам'ятати, чи він уже зберігав.
 * Порядок: права → стан → вміст → запис (як у set_criteria).
 */
export function saveShortlist(ctx: Ctx, searchId: string, input: unknown): { added: string[]; alreadyPresent: string[]; total: number } {
  const { search } = authorizeSearch(ctx, "save_shortlist", "search.save_shortlist", ctx.store.searchById(searchId), searchId);
  assertOpen(search);

  const parsed = SaveShortlistItems.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);

  return ctx.store.addShortlistItems(search.id, parsed.data);
}
