import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADAPTERS, type RawSources, buildCatalog } from "../src/catalog.ts";

/**
 * Вправа 3 етапу 2: агрегатор і політика битих записів.
 * Правило: битий запис (не та форма або AdapterError) — пропустити й записати причину;
 * будь-яка інша помилка — це баг у нашому коді, і її НЕ можна ховати.
 */
const fixtures = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", name), "utf8"));
const traps = fixtures("traps.json") as { fxUsdUah: number; duplicates: unknown[] };
const opts = { fxUsdUah: traps.fxUsdUah };

/** Свіжа копія сирих даних для кожного тесту: тест може їх псувати. */
const freshRaw = (): RawSources => ({ olx: fixtures("listings.olx.json"), lun: fixtures("listings.lun.json") });

/** Знайти сирий запис OLX за id, щоб зіпсувати саме його. */
const olxRecord = (raw: RawSources, id: number) => raw.olx.find((r) => (r as { id: number }).id === id) as Record<string, any>;

describe("Каталог (вправа 3)", () => {
  it("на чистих фікстурах: 70 квартир, 10 псевдонімів, нічого не пропущено", () => {
    const c = buildCatalog(freshRaw(), opts);
    expect(c.listings).toHaveLength(70);
    expect(c.aliasOf.size).toBe(traps.duplicates.length);
    expect(c.skipped).toEqual([]);
  });

  it("у кожної квартири є контакт, але лише в окремій мапі", () => {
    const c = buildCatalog(freshRaw(), opts);
    for (const l of c.listings) {
      expect(c.contacts.get(l.key)?.listingKey).toBe(l.key);
    }
  });

  it("один битий запис з 80 (невідомий район) пропускається, решта працює", () => {
    const raw = freshRaw();
    olxRecord(raw, 900000000).location.district = "Пустомити";
    const c = buildCatalog(raw, opts);
    expect(c.listings).toHaveLength(69);
    expect(c.listings.some((l) => l.key === "olx:900000000")).toBe(false);
    expect(c.skipped).toEqual([{ key: "olx:900000000", reason: expect.stringContaining("Пустомити") }]);
  });

  it("запис, що не відповідає сирій схемі джерела, теж пропускається — з номером у списку", () => {
    const raw = freshRaw();
    (raw.lun[0] as Record<string, unknown>).floor = "третій";
    const c = buildCatalog(raw, opts);
    expect(c.listings).toHaveLength(69);
    expect(c.skipped).toHaveLength(1);
    expect(c.skipped[0]?.key).toBe("lun:#0");
    expect(c.skipped[0]?.reason).toMatch(/floor/);
  });

  it("баг в адаптері (не AdapterError) не ховається: каталог падає", () => {
    const buggy = {
      ...DEFAULT_ADAPTERS,
      olx: () => {
        throw new TypeError("Cannot read properties of undefined");
      },
    };
    expect(() => buildCatalog(freshRaw(), opts, buggy)).toThrow(TypeError);
  });
});
