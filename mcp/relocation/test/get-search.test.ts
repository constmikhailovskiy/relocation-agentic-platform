import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Ctx } from "../src/context.ts";
import { getSearch } from "../src/get-search.ts";
import type { RelocationStore } from "../src/store.ts";
import { errorOf, freshWorld } from "./helpers.ts";

/**
 * get_search(employee_id): відповідь залежить від того, ХТО питає (principal), а не від того, що передала модель.
 * Класичні тести з case.md: Іван не дізнається бюджет Олени; Максим не бачить чужого пошуку за ID.
 */
let store: RelocationStore;
let audit: AuditEvent[];
let ctx: (sub: string, act?: string) => Ctx;

beforeEach(() => {
  ({ store, audit, ctx } = freshWorld());
});

describe("get_search: повне представлення", () => {
  it("Олена бачить свій пошук: бюджет, ліміт компанії, критерії, шортлист", () => {
    const view = getSearch(ctx("olena"), "olena");
    expect(view).toMatchObject({ id: "s-olena", employeeId: "olena", status: "searching", companyCapUah: 20000, shortlist: [] });
    expect(view.criteria?.maxBudgetUah).toBe(18000);
  });

  it("Тарас (relocation-менеджер) бачить будь-чий пошук повністю", () => {
    expect(getSearch(ctx("taras"), "olena").companyCapUah).toBe(20000);
    expect(getSearch(ctx("taras"), "maksym").companyCapUah).toBe(15000);
  });
});

describe("get_search: проєкція полів для керівника", () => {
  it("Іван бачить лише id, employeeId і status", () => {
    expect(Object.keys(getSearch(ctx("ivan"), "olena")).sort()).toEqual(["employeeId", "id", "status"]);
  });

  it("у JSON для Івана немає ні бюджету, ні ліміту, ні шортлиста — навіть коли шортлист є", () => {
    store.addShortlistItems("s-olena", [{ listingKey: "olx:1001", reason: "до 18000 грн, пральна машина" }]);
    const json = JSON.stringify(getSearch(ctx("ivan"), "olena"));
    for (const secret of ["18000", "20000", "olx:1001", "washing_machine", "criteria", "shortlist"]) {
      expect(json).not.toContain(secret);
    }
  });
});

describe("get_search: відмова виглядає як «не знайдено»", () => {
  it.each([
    { who: "Максим (інший новий працівник)", sub: "maksym" },
    { who: "Софія (керівник, але не Олени)", sub: "sofiia" },
    { who: "Богдан (agent builder)", sub: "bohdan" },
  ])("$who → not_found, з тим самим текстом, що й для неіснуючого працівника", ({ sub }) => {
    const denied = errorOf(() => getSearch(ctx(sub), "olena"));
    const missing = errorOf(() => getSearch(ctx("taras"), "nobody"));
    expect(denied.code).toBe("not_found");
    // Інакше перебором ID можна дізнатися, у кого є пошук (enumeration).
    expect(denied.message).toBe(missing.message);
  });

  it("невідомий principal → unknown_principal", () => {
    expect(errorOf(() => getSearch(ctx("mallory"), "olena")).code).toBe("unknown_principal");
  });

  it("agent від імені Максима з act=taras не стає Тарасом", () => {
    expect(errorOf(() => getSearch(ctx("maksym", "taras"), "olena")).code).toBe("not_found");
  });
});

describe("get_search: аудит", () => {
  it("рішення authorize потрапляє в аудит: allow_partial для Івана", () => {
    getSearch(ctx("ivan", "agent:concierge@7"), "olena");
    expect(audit).toEqual([
      {
        action: "relocation.get_search",
        actor: "ivan",
        agent: "agent:concierge@7",
        resource: "s-olena",
        decision: "allow_partial",
        reason: "manager_of",
      },
    ]);
  });

  it("відмова теж подія: deny з причиною, хоча клієнт бачить лише not_found", () => {
    errorOf(() => getSearch(ctx("maksym"), "olena"));
    expect(audit).toMatchObject([{ actor: "maksym", resource: "s-olena", decision: "deny", reason: "no_relation" }]);
  });
});
