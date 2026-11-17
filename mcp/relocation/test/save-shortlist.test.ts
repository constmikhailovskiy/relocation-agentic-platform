import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../src/context.ts";
import { getSearch } from "../src/get-search.ts";
import { saveShortlist } from "../src/save-shortlist.ts";
import type { RelocationStore } from "../src/store.ts";
import { errorOf, freshWorld } from "./helpers.ts";

/**
 * save_shortlist(search_id, items) — ідемпотентний за (search_id, listing_key).
 * Навіщо: агент повторює виклик після таймауту, ретраю в Temporal або просто «на всяк випадок».
 * Повтор не має ні дублювати рядки, ні падати.
 */
let store: RelocationStore;
let ctx: (sub: string, act?: string) => Ctx;

beforeEach(() => {
  ({ store, ctx } = freshWorld());
});

const two = [
  { listingKey: "olx:1001", reason: "2 кімнати, пральна машина" },
  { listingKey: "lun:2002", reason: "15 хв до офісу" },
];

describe("save_shortlist: ідемпотентність", () => {
  it("перший виклик додає все", () => {
    expect(saveShortlist(ctx("olena"), "s-olena", two)).toEqual({ added: ["olx:1001", "lun:2002"], alreadyPresent: [], total: 2 });
  });

  it("повтор того самого виклику нічого не дублює і не падає", () => {
    saveShortlist(ctx("olena"), "s-olena", two);
    expect(saveShortlist(ctx("olena"), "s-olena", two)).toEqual({ added: [], alreadyPresent: ["olx:1001", "lun:2002"], total: 2 });
    expect(getSearch(ctx("olena"), "olena").shortlist).toHaveLength(2);
  });

  it("частковий перетин: нове додається, старе лишається як було (перший reason виграє)", () => {
    saveShortlist(ctx("olena"), "s-olena", two);
    const res = saveShortlist(ctx("olena"), "s-olena", [
      { listingKey: "olx:1001", reason: "інший текст" },
      { listingKey: "olx:3003" },
    ]);
    expect(res).toEqual({ added: ["olx:3003"], alreadyPresent: ["olx:1001"], total: 3 });
    expect(store.shortlist("s-olena")[0]).toEqual({ listingKey: "olx:1001", reason: "2 кімнати, пральна машина" });
  });

  it("дубль усередині одного виклику записується один раз", () => {
    expect(saveShortlist(ctx("olena"), "s-olena", [{ listingKey: "olx:1001" }, { listingKey: "olx:1001" }])).toEqual({
      added: ["olx:1001"],
      alreadyPresent: [],
      total: 1,
    });
  });
});

describe("save_shortlist: вхід, права, стан", () => {
  it.each([
    { what: "порожній список", items: [] },
    { what: "не масив", items: "olx:1001" },
    { what: "порожній ключ", items: [{ listingKey: "" }] },
    { what: "забагато за раз (21)", items: Array.from({ length: 21 }, (_, i) => ({ listingKey: `olx:${i}` })) },
  ])("$what → invalid_input", ({ items }) => {
    expect(errorOf(() => saveShortlist(ctx("olena"), "s-olena", items)).code).toBe("invalid_input");
  });

  it.each([
    { sub: "maksym", code: "not_found" },
    { sub: "ivan", code: "forbidden" },
  ])("$sub не може писати в шортлист Олени → $code, нічого не записано", ({ sub, code }) => {
    expect(errorOf(() => saveShortlist(ctx(sub), "s-olena", two)).code).toBe(code);
    expect(store.shortlist("s-olena")).toEqual([]);
  });

  it("неіснуючий search_id → not_found", () => {
    expect(errorOf(() => saveShortlist(ctx("taras"), "s-nobody", two)).code).toBe("not_found");
  });

  it("закритий пошук → search_closed", () => {
    store.setStatus("s-olena", "secured");
    expect(errorOf(() => saveShortlist(ctx("olena"), "s-olena", two)).code).toBe("search_closed");
  });
});
