import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Listing, LunRaw, OlxRaw } from "@reloc/shared";
import { lunToListing } from "../src/adapters/lun.ts";
import { olxToListing } from "../src/adapters/olx.ts";
import { dedupe } from "../src/dedupe.ts";

/**
 * Вправа 2 етапу 2. Ключ відповідей — traps.duplicates: 10 пар OLX ↔ ЛУН,
 * у 4 з них ціна на ЛУН на 500 грн вища. Дедуплікація про traps.json нічого не знає.
 */
const fixtures = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", name), "utf8"));
const traps = fixtures("traps.json") as { fxUsdUah: number; duplicates: { olx: string; lun: string; priceDeltaUah: number }[] };
const opts = { fxUsdUah: traps.fxUsdUah };
const olx = z.array(OlxRaw).parse(fixtures("listings.olx.json")).map((r) => olxToListing(r, opts).listing);
const lun = z.array(LunRaw).parse(fixtures("listings.lun.json")).map((r) => lunToListing(r, opts).listing);
const all = [...olx, ...lun];
const byKey = (key: string): Listing => structuredClone(all.find((l) => l.key === key)!);

describe("Дедуплікація (вправа 2)", () => {
  it("80 оголошень → 70 квартир: 48 + 32 − 10 дублів", () => {
    expect(dedupe(all).listings).toHaveLength(70);
  });

  it("кожна пара з traps.duplicates злилась: лишився OLX-оригінал, ЛУН став псевдонімом", () => {
    const { listings, aliasOf } = dedupe(all);
    const keys = new Set(listings.map((l) => l.key));
    for (const pair of traps.duplicates) {
      expect(keys.has(pair.olx)).toBe(true);
      expect(keys.has(pair.lun)).toBe(false);
      expect(aliasOf.get(pair.lun)).toBe(pair.olx);
    }
    expect(aliasOf.size).toBe(10);
  });

  it("лишається раніше опублікована копія — незалежно від порядку на вході", () => {
    // ЛУН першим у масиві, але OLX опубліковано раніше → лишається OLX.
    const { listings } = dedupe([...lun, ...olx]);
    const pair = traps.duplicates[0]!;
    expect(listings.some((l) => l.key === pair.olx)).toBe(true);
    expect(listings.some((l) => l.key === pair.lun)).toBe(false);
  });

  it("різниця в ціні не заважає злиттю (ціна — не частина відбитка)", () => {
    const pair = traps.duplicates.find((d) => d.priceDeltaUah === 500)!;
    const { listings, aliasOf } = dedupe([byKey(pair.olx), byKey(pair.lun)]);
    expect(listings).toHaveLength(1);
    expect(aliasOf.get(pair.lun)).toBe(pair.olx);
  });

  it("інший поверх — це інша квартира, навіть якщо все інше збігається", () => {
    const pair = traps.duplicates[0]!;
    const other = byKey(pair.lun);
    other.floor += 1;
    expect(dedupe([byKey(pair.olx), other]).listings).toHaveLength(2);
  });

  it("зайві пробіли й регістр у назві вулиці не ламають злиття", () => {
    const pair = traps.duplicates[0]!;
    const messy = byKey(pair.lun);
    messy.street = `  ${messy.street.toUpperCase().replace(" ", "   ")} `;
    expect(dedupe([byKey(pair.olx), messy]).listings).toHaveLength(1);
  });
});
