import type { Criteria, SearchField, SearchStatus, ShortlistItem } from "@reloc/shared";
import { type Ctx, authorizeSearch } from "./context.ts";

/** Повне представлення пошуку. Для керівника з нього лишаться тільки дозволені поля. */
export interface SearchView {
  id: string;
  employeeId: string;
  status: SearchStatus;
  criteria?: Criteria;
  companyCapUah?: number;
  shortlist?: readonly ShortlistItem[];
}

/**
 * get_search(employee_id). `employeeId` приходить від моделі, тож це лише «що шукати»;
 * «чи можна» вирішує authorize за principal.
 */
export function getSearch(ctx: Ctx, employeeId: string): SearchView {
  const { search: s, fields } = authorizeSearch(ctx, "get_search", "search.read", ctx.store.searchByEmployee(employeeId), `employee:${employeeId}`);

  const full: SearchView = {
    id: s.id,
    employeeId: s.employeeId,
    status: s.status,
    ...(s.criteria && { criteria: s.criteria }),
    companyCapUah: s.companyCapUah,
    shortlist: ctx.store.shortlist(s.id),
  };

  // Проєкція З allowlist: нове поле в SearchView нікому не потрапить, доки його не додадуть у fields.
  return Object.fromEntries(fields.filter((f: SearchField) => f in full).map((f) => [f, full[f]])) as unknown as SearchView;
}
