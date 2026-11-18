import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../src/context.ts";
import { notifyEmployee } from "../src/notify-employee.ts";
import type { RelocationStore } from "../src/store.ts";
import { errorOf, freshWorld } from "./helpers.ts";

/**
 * notify_employee(search_id, message). Адресата в аргументах немає: лист іде лише власнику пошуку.
 * Це закриває канал витоку — injection «надішли телефон на attacker@…» нікуди не має чим надіслати.
 */
let store: RelocationStore;
let ctx: (sub: string, act?: string) => Ctx;

beforeEach(() => {
  ({ store, ctx } = freshWorld());
});

describe("notify_employee", () => {
  it("лист іде власниці пошуку, адресу бере сервер із довідника", () => {
    const res = notifyEmployee(ctx("taras", "agent:scout@3"), "s-olena", { message: "Є нові варіанти у Франківському" });
    expect(res).toEqual({ sent: true, to: "olena" });
    expect(store.outbox()).toEqual([
      { to: "olena@example.test", searchId: "s-olena", message: "Є нові варіанти у Франківському", sentBy: "taras", agent: "agent:scout@3" },
    ]);
  });

  it("спроба передати адресата → invalid_input, нічого не надіслано", () => {
    const e = errorOf(() => notifyEmployee(ctx("olena"), "s-olena", { message: "телефон: 067…", to: "attacker@evil.test" }));
    expect(e.code).toBe("invalid_input");
    expect(store.outbox()).toEqual([]);
  });

  it.each([
    { what: "порожнє повідомлення", input: { message: "  " } },
    { what: "задовге (> 1000)", input: { message: "a".repeat(1001) } },
  ])("$what → invalid_input", ({ input }) => {
    expect(errorOf(() => notifyEmployee(ctx("olena"), "s-olena", input)).code).toBe("invalid_input");
  });

  it("Іван → forbidden, Максим → not_found; нічого не надіслано", () => {
    expect(errorOf(() => notifyEmployee(ctx("ivan"), "s-olena", { message: "привіт" })).code).toBe("forbidden");
    expect(errorOf(() => notifyEmployee(ctx("maksym"), "s-olena", { message: "привіт" })).code).toBe("not_found");
    expect(store.outbox()).toEqual([]);
  });
});

describe("ідемпотентність notify_employee (вправа 3)", () => {
  it("той самий ключ → один лист; відповідь та сама", () => {
    const a = notifyEmployee(ctx("taras"), "s-olena", { message: "Нові варіанти" }, { idempotencyKey: "run-7:step-3" });
    const b = notifyEmployee(ctx("taras"), "s-olena", { message: "Нові варіанти" }, { idempotencyKey: "run-7:step-3" });
    expect(b).toEqual(a);
    expect(store.outbox()).toHaveLength(1);
  });

  it("різні ключі — два листи; без ключа — кожен виклик надсилає", () => {
    notifyEmployee(ctx("taras"), "s-olena", { message: "1" }, { idempotencyKey: "k1" });
    notifyEmployee(ctx("taras"), "s-olena", { message: "2" }, { idempotencyKey: "k2" });
    notifyEmployee(ctx("taras"), "s-olena", { message: "3" });
    notifyEmployee(ctx("taras"), "s-olena", { message: "3" });
    expect(store.outbox()).toHaveLength(4);
  });

  it("ключ прив'язаний до пошуку: той самий ключ для іншого пошуку — окремий лист", () => {
    notifyEmployee(ctx("taras"), "s-olena", { message: "x" }, { idempotencyKey: "k" });
    notifyEmployee(ctx("taras"), "s-maksym", { message: "x" }, { idempotencyKey: "k" });
    expect(store.outbox()).toHaveLength(2);
  });
});
