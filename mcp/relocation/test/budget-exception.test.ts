import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../src/context.ts";
import { decideBudgetException, requestBudgetException } from "../src/budget-exception.ts";
import { setCriteria } from "../src/set-criteria.ts";
import type { RelocationStore } from "../src/store.ts";
import { errorOf, freshWorld } from "./helpers.ts";

/**
 * request_budget_exception(search_id, amount, reason) створює approval. Схвалити його агент не може:
 * інструмента «approve» немає взагалі. decideBudgetException — дія людини в UI (не інструмент):
 * лише relocation-менеджер, не через агента і не щодо власного запиту (розділення обов'язків).
 */
let store: RelocationStore;
let ctx: (sub: string, act?: string) => Ctx;
const AGENT = "agent:concierge@7";

beforeEach(() => {
  ({ store, ctx } = freshWorld());
});

describe("request_budget_exception", () => {
  it("Олена (через агента) просить 25000 при ліміті 20000 → pending", () => {
    const res = requestBudgetException(ctx("olena", AGENT), "s-olena", 25000, "Дві кімнати з котом у Франківському");
    expect(res).toMatchObject({ status: "pending", amountUah: 25000, capUah: 20000 });
  });

  it("сума в межах ліміту → invalid_input: виняток не потрібен", () => {
    expect(errorOf(() => requestBudgetException(ctx("olena"), "s-olena", 19000, "про всяк випадок")).code).toBe("invalid_input");
  });

  it("повторний запит, поки перший не вирішено, повертає той самий (без спаму в HR)", () => {
    const a = requestBudgetException(ctx("olena"), "s-olena", 25000, "перший");
    const b = requestBudgetException(ctx("olena"), "s-olena", 26000, "другий");
    expect(b.approvalId).toBe(a.approvalId);
    expect(b.amountUah).toBe(25000);
  });

  it("чужий pending-запит не повертається: запит Тараса не стає запитом Олени (інакше SoD заблокує його назавжди)", () => {
    const taras = requestBudgetException(ctx("taras"), "s-olena", 25000, "Тарас");
    const olena = requestBudgetException(ctx("olena"), "s-olena", 25000, "Олена");
    expect(olena.approvalId).not.toBe(taras.approvalId);
    expect(decideBudgetException(ctx("taras"), olena.approvalId, "approved").status).toBe("approved");
  });

  it("Іван → forbidden, Максим → not_found", () => {
    expect(errorOf(() => requestBudgetException(ctx("ivan"), "s-olena", 25000, "x")).code).toBe("forbidden");
    expect(errorOf(() => requestBudgetException(ctx("maksym"), "s-olena", 25000, "x")).code).toBe("not_found");
  });
});

describe("decideBudgetException (людина в UI, не інструмент)", () => {
  it("Тарас схвалює запит Олени → ліміт піднято, set_criteria на 25000 тепер проходить", () => {
    const req = requestBudgetException(ctx("olena", AGENT), "s-olena", 25000, "кіт");
    expect(decideBudgetException(ctx("taras"), req.approvalId, "approved")).toMatchObject({ status: "approved" });
    expect(store.searchById("s-olena")?.companyCapUah).toBe(25000);
    expect(() => setCriteria(ctx("olena"), "olena", { maxBudgetUah: 25000 })).not.toThrow();
  });

  it("відхилення не змінює ліміт", () => {
    const req = requestBudgetException(ctx("olena"), "s-olena", 25000, "кіт");
    decideBudgetException(ctx("taras"), req.approvalId, "rejected");
    expect(store.searchById("s-olena")?.companyCapUah).toBe(20000);
  });

  it("Тарас не схвалює власний запит (розділення обов'язків) → forbidden", () => {
    const req = requestBudgetException(ctx("taras"), "s-olena", 25000, "сам попросив");
    expect(errorOf(() => decideBudgetException(ctx("taras"), req.approvalId, "approved")).code).toBe("forbidden");
  });

  it("через агента не схвалюється навіть Тарасом (principal з act) → forbidden", () => {
    const req = requestBudgetException(ctx("olena"), "s-olena", 25000, "кіт");
    expect(errorOf(() => decideBudgetException(ctx("taras", AGENT), req.approvalId, "approved")).code).toBe("forbidden");
  });

  it("Олена не схвалює сама собі → forbidden", () => {
    const req = requestBudgetException(ctx("olena"), "s-olena", 25000, "кіт");
    expect(errorOf(() => decideBudgetException(ctx("olena"), req.approvalId, "approved")).code).toBe("forbidden");
  });

  it("вирішене вдруге → already_decided", () => {
    const req = requestBudgetException(ctx("olena"), "s-olena", 25000, "кіт");
    decideBudgetException(ctx("taras"), req.approvalId, "rejected");
    expect(errorOf(() => decideBudgetException(ctx("taras"), req.approvalId, "approved")).code).toBe("already_decided");
  });
});
