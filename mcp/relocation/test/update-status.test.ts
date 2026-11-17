import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Ctx } from "../src/context.ts";
import type { RelocationStore } from "../src/store.ts";
import { updateStatus } from "../src/update-status.ts";
import { errorOf, freshWorld } from "./helpers.ts";

/**
 * update_status(search_id, to, reason). Критерій готовності етапу 2 з case.md:
 * «update_status відхиляє недозволений перехід». Джерело правди — TRANSITIONS у packages/shared.
 */
let store: RelocationStore;
let audit: AuditEvent[];
let ctx: (sub: string, act?: string) => Ctx;

beforeEach(() => {
  ({ store, audit, ctx } = freshWorld());
});

const status = () => store.searchById("s-olena")?.status;

describe("update_status: дозволені переходи", () => {
  it("Олена: searching → shortlist_ready", () => {
    expect(updateStatus(ctx("olena"), "s-olena", "shortlist_ready", "Є три варіанти")).toEqual({
      searchId: "s-olena",
      from: "searching",
      to: "shortlist_ready",
    });
    expect(status()).toBe("shortlist_ready");
  });

  it("причина не губиться: перехід записано в історію з причиною, автором і часом", () => {
    updateStatus(ctx("olena", "agent:concierge@7"), "s-olena", "shortlist_ready", "Є три варіанти");
    expect(store.statusHistory("s-olena")).toEqual([
      { from: "searching", to: "shortlist_ready", reason: "Є три варіанти", by: "olena", agent: "agent:concierge@7", at: "2026-11-20T10:00:00.000Z" },
    ]);
  });

  it("Тарас: hr_approval → secured", () => {
    store.setStatus("s-olena", "hr_approval");
    expect(updateStatus(ctx("taras"), "s-olena", "secured", "Договір підписано").to).toBe("secured");
  });
});

describe("update_status: недозволений перехід", () => {
  it("searching → viewing_requested (перескок через shortlist_ready) → invalid_transition; повідомлення перелічує дозволені; статус не змінився", () => {
    store.setStatus("s-olena", "searching");
    const e = errorOf(() => updateStatus(ctx("taras"), "s-olena", "viewing_requested", "Хочу одразу"));
    expect(e.code).toBe("invalid_transition");
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("shortlist_ready");
    expect(status()).toBe("searching");
  });

  it("навіть Тарас не перескакує: роль не обходить діаграму станів", () => {
    expect(errorOf(() => updateStatus(ctx("taras"), "s-olena", "secured", "Швидше")).code).toBe("invalid_transition");
  });

  it("той самий статус (searching → searching) — теж не перехід", () => {
    expect(errorOf(() => updateStatus(ctx("olena"), "s-olena", "searching", "ще раз")).code).toBe("invalid_transition");
  });

  it("із кінцевого статусу → search_closed", () => {
    store.setStatus("s-olena", "cancelled");
    expect(errorOf(() => updateStatus(ctx("taras"), "s-olena", "searching", "Передумала")).code).toBe("search_closed");
  });
});

describe("update_status: хто може", () => {
  it("Олена не може сама позначити secured → forbidden (бачить пошук, тому не not_found)", () => {
    store.setStatus("s-olena", "hr_approval");
    const e = errorOf(() => updateStatus(ctx("olena"), "s-olena", "secured", "Я підписала"));
    expect(e.code).toBe("forbidden");
    expect(status()).toBe("hr_approval");
    expect(audit.at(-1)).toMatchObject({ action: "relocation.update_status", decision: "deny", reason: "requires_relocation_manager" });
  });

  it("Іван (керівник) → forbidden; Максим → not_found", () => {
    expect(errorOf(() => updateStatus(ctx("ivan"), "s-olena", "paused", "Відпустка")).code).toBe("forbidden");
    expect(errorOf(() => updateStatus(ctx("maksym"), "s-olena", "paused", "Відпустка")).code).toBe("not_found");
    expect(status()).toBe("searching");
  });
});

describe("update_status: вхід", () => {
  it.each([
    { what: "невідомий статус", to: "done", reason: "ок" },
    { what: "порожня причина", to: "paused", reason: "" },
  ])("$what → invalid_input", ({ to, reason }) => {
    expect(errorOf(() => updateStatus(ctx("olena"), "s-olena", to, reason)).code).toBe("invalid_input");
  });
});
