import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Ctx } from "../src/context.ts";
import { confirmViewing, requestViewing } from "../src/request-viewing.ts";
import type { RelocationStore } from "../src/store.ts";
import { errorOf, freshWorld } from "./helpers.ts";

/**
 * request_viewing(search_id, listing_key, slots) — інструмент високого ризику: контакт з орендодавцем.
 * Агент лише СТВОРЮЄ запит у стані pending_confirmation. Підтверджує людина (confirmViewing — не інструмент;
 * на етапі 3 його викличе runtime після «y» у чаті). Підтвердження прив'язане до args_hash.
 */
let store: RelocationStore;
let audit: AuditEvent[];
let ctx: (sub: string, act?: string) => Ctx;

const AGENT = "agent:concierge@7";
const slots = ["2026-11-22T15:00:00.000Z", "2026-11-23T11:00:00.000Z"];

beforeEach(() => {
  ({ store, audit, ctx } = freshWorld());
  store.addShortlistItems("s-olena", [{ listingKey: "olx:1001" }, { listingKey: "lun:2002" }]);
  store.setStatus("s-olena", "shortlist_ready");
});

describe("request_viewing: створює запит, але нічого не відправляє", () => {
  it("агент від імені Олени → pending_confirmation з args_hash; статус пошуку ще не змінився", () => {
    const res = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots);
    expect(res).toMatchObject({ status: "pending_confirmation", listingKey: "olx:1001" });
    expect(res.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.searchById("s-olena")?.status).toBe("shortlist_ready");
  });

  it("повтор з тими самими аргументами повертає той самий запит (ідемпотентно)", () => {
    const a = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots);
    const b = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", [...slots].reverse());
    expect(b.approvalId).toBe(a.approvalId);
  });

  it("той самий хеш від ІНШОГО користувача — окремий запит: Олена не отримує запит Тараса", () => {
    const taras = requestViewing(ctx("taras"), "s-olena", "olx:1001", slots);
    const olena = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots);
    expect(olena.approvalId).not.toBe(taras.approvalId);
    expect(confirmViewing(ctx("olena"), olena.approvalId, olena.argsHash).status).toBe("confirmed");
  });

  it("інші слоти — інший хеш", () => {
    const a = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots);
    const b = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", [slots[0]!]);
    expect(b.argsHash).not.toBe(a.argsHash);
  });
});

describe("request_viewing: обмеження", () => {
  it("лише оголошення з шортлиста → not_in_shortlist (injection в описі не приведе агента до чужої квартири)", () => {
    expect(errorOf(() => requestViewing(ctx("olena", AGENT), "s-olena", "olx:9999", slots)).code).toBe("not_in_shortlist");
  });

  it("статус searching (шортлиста ще немає) → wrong_status", () => {
    store.setStatus("s-olena", "searching");
    expect(errorOf(() => requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots)).code).toBe("wrong_status");
  });

  it.each([
    { what: "порожні слоти", s: [] },
    { what: "слот у минулому", s: ["2026-11-19T10:00:00.000Z"] },
    { what: "не дата", s: ["завтра о 15"] },
    { what: "забагато слотів", s: ["a", "b", "c", "d"].map((_, i) => `2026-11-2${i + 1}T10:00:00.000Z`) },
  ])("$what → invalid_input", ({ s }) => {
    expect(errorOf(() => requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", s)).code).toBe("invalid_input");
  });

  it("Іван → forbidden, Максим → not_found", () => {
    expect(errorOf(() => requestViewing(ctx("ivan"), "s-olena", "olx:1001", slots)).code).toBe("forbidden");
    expect(errorOf(() => requestViewing(ctx("maksym"), "s-olena", "olx:1001", slots)).code).toBe("not_found");
  });
});

describe("confirmViewing: підтвердження людиною (не інструмент)", () => {
  it("Олена підтверджує саме ці аргументи → confirmed, пошук → viewing_requested, подія в аудиті", () => {
    const req = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots);
    expect(confirmViewing(ctx("olena"), req.approvalId, req.argsHash)).toMatchObject({ status: "confirmed" });
    expect(store.searchById("s-olena")?.status).toBe("viewing_requested");
    expect(audit.at(-1)).toMatchObject({ action: "relocation.confirm_viewing", actor: "olena", decision: "allow" });
  });

  it("хеш не збігся (агент підмінив слот після показу користувачу) → args_mismatch, нічого не змінилось", () => {
    const shown = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots);
    const e = errorOf(() => confirmViewing(ctx("olena"), shown.approvalId, "0".repeat(64)));
    expect(e.code).toBe("args_mismatch");
    expect(store.searchById("s-olena")?.status).toBe("shortlist_ready");
  });

  it("агент не може підтвердити сам собі: principal з act → forbidden", () => {
    const req = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots);
    expect(errorOf(() => confirmViewing(ctx("olena", AGENT), req.approvalId, req.argsHash)).code).toBe("forbidden");
  });

  it("підтверджує лише той, хто просив (Тарас не підтверджує за Олену) → forbidden", () => {
    const req = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots);
    expect(errorOf(() => confirmViewing(ctx("taras"), req.approvalId, req.argsHash)).code).toBe("forbidden");
  });

  it("друге підтвердження → already_decided", () => {
    const req = requestViewing(ctx("olena", AGENT), "s-olena", "olx:1001", slots);
    confirmViewing(ctx("olena"), req.approvalId, req.argsHash);
    expect(errorOf(() => confirmViewing(ctx("olena"), req.approvalId, req.argsHash)).code).toBe("already_decided");
  });
});
