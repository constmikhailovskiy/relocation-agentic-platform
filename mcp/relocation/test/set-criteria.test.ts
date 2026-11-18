import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Ctx } from "../src/context.ts";
import { getSearch } from "../src/get-search.ts";
import { setCriteria } from "../src/set-criteria.ts";
import type { RelocationStore } from "../src/store.ts";
import { errorOf, freshWorld } from "./helpers.ts";

/**
 * set_criteria(employee_id, criteria). Вхід приходить від моделі, яка витягла критерії з вільного тексту,
 * тож усе перевіряється zod-схемою Criteria — тією самою, з якої модель отримала JSON Schema.
 */
let store: RelocationStore;
let audit: AuditEvent[];
let ctx: (sub: string, act?: string) => Ctx;

beforeEach(() => {
  ({ store, audit, ctx } = freshWorld());
});

describe("set_criteria: успіх", () => {
  it("Олена змінює свої критерії; дефолти схеми підставлені, get_search бачить нове", () => {
    const res = setCriteria(ctx("olena"), "olena", { maxBudgetUah: 17000, minRooms: 1, pets: true });
    expect(res.criteria).toEqual({ maxBudgetUah: 17000, minRooms: 1, districts: [], excludeDistricts: [], pets: true, mustHave: [] });
    expect(getSearch(ctx("olena"), "olena").criteria?.maxBudgetUah).toBe(17000);
  });

  it("Тарас може змінити критерії будь-кого", () => {
    expect(setCriteria(ctx("taras"), "maksym", { maxBudgetUah: 15000 }).criteria.maxBudgetUah).toBe(15000);
  });

  it("бюджет рівно на ліміті компанії — можна", () => {
    expect(() => setCriteria(ctx("olena"), "olena", { maxBudgetUah: 20000 })).not.toThrow();
  });
});

describe("set_criteria: бюджет понад ліміт компанії", () => {
  it("over_cap з підказкою про request_budget_exception і без запису", () => {
    const e = errorOf(() => setCriteria(ctx("olena"), "olena", { maxBudgetUah: 25000 }));
    expect(e.code).toBe("over_cap");
    expect(e.retryable).toBe(false);
    // Повідомлення — для моделі: що сталося, яка межа і що робити далі.
    expect(e.message).toContain("20000");
    expect(e.message).toContain("request_budget_exception");
    expect(getSearch(ctx("olena"), "olena").criteria?.maxBudgetUah).toBe(18000);
  });

  it("навіть relocation-менеджер не обходить ліміт інструментом — лише через схвалення людиною", () => {
    expect(errorOf(() => setCriteria(ctx("taras"), "olena", { maxBudgetUah: 25000 })).code).toBe("over_cap");
  });
});

describe("set_criteria: невалідний вхід", () => {
  it.each([
    { what: "бюджет рядком", input: { maxBudgetUah: "18 тис." } },
    { what: "неіснуючий район", input: { maxBudgetUah: 15000, districts: ["obolonskyi"] } },
    { what: "район і бажаний, і виключений", input: { maxBudgetUah: 15000, districts: ["halytskyi"], excludeDistricts: ["halytskyi"] } },
  ])("$what → invalid_input, у повідомленні шлях до поля", ({ input }) => {
    const e = errorOf(() => setCriteria(ctx("olena"), "olena", input));
    expect(e.code).toBe("invalid_input");
    expect(e.message).toMatch(/maxBudgetUah|districts|excludeDistricts/);
  });

  it("невалідний вхід не пише аудит-подію «allow»: спершу права, потім вміст", () => {
    errorOf(() => setCriteria(ctx("maksym"), "olena", { maxBudgetUah: "x" }));
    // Максим не має прав на пошук Олени — він дізнається лише not_found, а не помилку валідації.
    expect(audit).toMatchObject([{ actor: "maksym", decision: "deny" }]);
  });
});

describe("set_criteria: права і стан", () => {
  it.each(["maksym", "bohdan"])("%s пошуку Олени не бачить → not_found", (sub) => {
    expect(errorOf(() => setCriteria(ctx(sub), "olena", { maxBudgetUah: 15000 })).code).toBe("not_found");
    expect(getSearch(ctx("olena"), "olena").criteria?.maxBudgetUah).toBe(18000);
  });

  it("Іван пошук бачить (статус), але змінювати не може → forbidden: приховувати вже нічого", () => {
    const e = errorOf(() => setCriteria(ctx("ivan"), "olena", { maxBudgetUah: 15000 }));
    expect(e.code).toBe("forbidden");
    expect(getSearch(ctx("olena"), "olena").criteria?.maxBudgetUah).toBe(18000);
  });

  it("закритий пошук (cancelled) не змінюється → search_closed", () => {
    store.setStatus("s-olena", "cancelled");
    expect(errorOf(() => setCriteria(ctx("olena"), "olena", { maxBudgetUah: 15000 })).code).toBe("search_closed");
  });
});

describe("set_criteria: нові критерії виводять з needs_attention (вправа 1)", () => {
  it("needs_attention → searching; перехід записано в історію з причиною", () => {
    store.setStatus("s-olena", "needs_attention");
    setCriteria(ctx("olena", "agent:concierge@7"), "olena", { maxBudgetUah: 19000 });
    expect(store.searchById("s-olena")?.status).toBe("searching");
    expect(store.statusHistory("s-olena")).toMatchObject([{ from: "needs_attention", to: "searching", by: "olena", agent: "agent:concierge@7" }]);
  });

  it("в інших статусах статус не змінюється і історія порожня", () => {
    store.setStatus("s-olena", "shortlist_ready");
    setCriteria(ctx("olena"), "olena", { maxBudgetUah: 19000 });
    expect(store.searchById("s-olena")?.status).toBe("shortlist_ready");
    expect(store.statusHistory("s-olena")).toEqual([]);
  });

  it("over_cap у needs_attention — статус лишається needs_attention", () => {
    store.setStatus("s-olena", "needs_attention");
    errorOf(() => setCriteria(ctx("olena"), "olena", { maxBudgetUah: 25000 }));
    expect(store.searchById("s-olena")?.status).toBe("needs_attention");
  });
});
