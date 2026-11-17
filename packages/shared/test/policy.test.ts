import { describe, expect, it } from "vitest";
import { type Action, type Actor, type SearchResource, SEARCH_FIELDS, authorize } from "../src/policy.ts";

/**
 * Матриця ролей із docs/case.md («Ролі та права») як таблиця тестів.
 * Пошук Олени: власниця olena, її керівник ivan. Пошук Максима: керівник sofiia.
 */
const olenaSearch: SearchResource = { kind: "search", ownerId: "olena", ownerManagerId: "ivan" };

const olena: Actor = { sub: "olena", roles: ["new_hire"] };
const maksym: Actor = { sub: "maksym", roles: ["new_hire"] };
const taras: Actor = { sub: "taras", roles: ["relocation_manager"] };
const ivan: Actor = { sub: "ivan", roles: ["hiring_manager"] };
const sofiia: Actor = { sub: "sofiia", roles: ["hiring_manager"] };
const bohdan: Actor = { sub: "bohdan", roles: ["agent_builder"] };
const auditor: Actor = { sub: "audrey", roles: ["auditor"] };

const WRITES: Action[] = [
  "search.set_criteria",
  "search.save_shortlist",
  "search.update_status",
  "search.request_viewing",
  "search.request_budget_exception",
  "search.notify_employee",
];

describe("authorize: читання пошуку (get_search)", () => {
  // it.each: один тест на рядок таблиці; $who підставляється в назву тесту.
  it.each([
    { who: "власниця (Олена)", actor: olena },
    { who: "relocation-менеджер (Тарас)", actor: taras },
  ])("$who бачить усі поля", ({ actor }) => {
    const d = authorize(actor, "search.read", olenaSearch);
    expect(d.decision).toBe("allow");
    expect(d.fields).toEqual(SEARCH_FIELDS);
  });

  it("керівник Олени (Іван) бачить лише статус — без бюджету, критеріїв і шортлиста", () => {
    const d = authorize(ivan, "search.read", olenaSearch);
    expect(d.decision).toBe("allow_partial");
    expect(d.fields).toEqual(["id", "employeeId", "status"]);
  });

  it.each([
    { who: "інший новий працівник (Максим) — горизонтальний доступ", actor: maksym },
    { who: "керівник іншої людини (Софія) — роль є, відношення manager_of немає", actor: sofiia },
    { who: "agent builder (Богдан) — реальних кандидатів не бачить", actor: bohdan },
    { who: "аудитор — бачить дії в аудиті, але не вміст", actor: auditor },
  ])("$who: deny", ({ actor }) => {
    const d = authorize(actor, "search.read", olenaSearch);
    expect(d.decision).toBe("deny");
    expect(d.fields).toEqual([]);
  });
});

describe("authorize: дії із записом", () => {
  it.each(WRITES)("%s: власниця і relocation-менеджер — allow", (action) => {
    expect(authorize(olena, action, olenaSearch).decision).toBe("allow");
    expect(authorize(taras, action, olenaSearch).decision).toBe("allow");
  });

  it.each(WRITES)("%s: керівник, інший працівник, builder, аудитор — deny", (action) => {
    for (const actor of [ivan, maksym, sofiia, bohdan, auditor]) {
      expect(authorize(actor, action, olenaSearch).decision).toBe("deny");
    }
  });
});

describe("authorize: позначити пошук secured (hr_approval → secured)", () => {
  it("лише relocation-менеджер: це рішення HR, а не працівника", () => {
    expect(authorize(taras, "search.mark_secured", olenaSearch).decision).toBe("allow");
    const own = authorize(olena, "search.mark_secured", olenaSearch);
    expect(own.decision).toBe("deny");
    expect(own.reason).toBe("requires_relocation_manager");
  });

  it.each([ivan, maksym, bohdan])("решта — deny", (actor) => {
    expect(authorize(actor, "search.mark_secured", olenaSearch).decision).toBe("deny");
  });
});

describe("authorize: делегування не розширює права", () => {
  it("агент від імені Максима не отримує прав, навіть якщо `act` схожий на привілейованого", () => {
    const viaAgent: Actor = { sub: "maksym", roles: ["new_hire"], act: { sub: "taras" } };
    expect(authorize(viaAgent, "search.read", olenaSearch).decision).toBe("deny");
  });

  it("агент від імені Олени має рівно її права", () => {
    const viaAgent: Actor = { sub: "olena", roles: ["new_hire"], act: { sub: "agent:concierge@7" } };
    expect(authorize(viaAgent, "search.read", olenaSearch)).toEqual(authorize(olena, "search.read", olenaSearch));
  });
});

describe("authorize: причина відмови", () => {
  it("кожне рішення має reason — він іде в аудит", () => {
    expect(authorize(maksym, "search.read", olenaSearch).reason).toBe("no_relation");
    expect(authorize(ivan, "search.read", olenaSearch).reason).toBe("manager_of");
    expect(authorize(ivan, "search.set_criteria", olenaSearch).reason).toBe("manager_read_only");
  });
});
