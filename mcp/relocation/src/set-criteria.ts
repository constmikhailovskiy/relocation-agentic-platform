import { Criteria } from "@reloc/shared";
import { type Ctx, RelocationError, assertOpen, authorizeSearch, invalidInput } from "./context.ts";

/**
 * set_criteria(employee_id, criteria). Порядок кроків важливий:
 *  1. права (authorizeSearch) — чужий бачить лише not_found, а не помилки валідації чужого пошуку;
 *  2. стан (закритий пошук не змінюється);
 *  3. вміст (zod) і бізнес-правило ліміту компанії;
 *  4. запис.
 * `input: unknown` — свідомо: від моделі може прийти що завгодно, тип з'являється лише після parse.
 */
export function setCriteria(ctx: Ctx, employeeId: string, input: unknown): { searchId: string; criteria: Criteria } {
  const { search } = authorizeSearch(ctx, "set_criteria", "search.set_criteria", ctx.store.searchByEmployee(employeeId), `employee:${employeeId}`);
  assertOpen(search);

  const parsed = Criteria.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);
  const criteria = parsed.data;

  // Ліміт — бізнес-правило сервера, не промпту. Обійти його інструментом не може ніхто, навіть менеджер:
  // перевищення погоджує людина через окремий процес схвалення.
  if (criteria.maxBudgetUah > search.companyCapUah) {
    throw new RelocationError(
      "over_cap",
      `Бюджет ${criteria.maxBudgetUah} грн перевищує ліміт компанії ${search.companyCapUah} грн. ` +
        `Збережи бюджет у межах ліміту або попроси виняток через request_budget_exception — його погоджує людина.`,
    );
  }

  ctx.store.updateCriteria(search.id, criteria);
  return { searchId: search.id, criteria };
}
