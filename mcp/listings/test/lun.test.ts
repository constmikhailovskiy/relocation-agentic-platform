import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Listing, LunRaw } from "@reloc/shared";
import { AdapterError } from "../src/adapters/errors.ts";
import { lunToListing } from "../src/adapters/lun.ts";

/** Вправа 1 етапу 2. Ті самі вимоги, що й до OLX, але сирий формат інший. */
const fixtures = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", name), "utf8"));
const lun = z.array(LunRaw).parse(fixtures("listings.lun.json"));
const traps = fixtures("traps.json") as { fxUsdUah: number; usd: string[] };
const opts = { fxUsdUah: traps.fxUsdUah };
const rawById = (id: string): LunRaw => structuredClone(lun.find((l) => l.listing_id === id)!);

describe("Адаптер ЛУН (вправа 1)", () => {
  it("кожен із 32 записів стає валідним Listing з ключем lun:<listing_id>", () => {
    for (const raw of lun) {
      const { listing } = lunToListing(raw, opts);
      expect(Listing.safeParse(listing).success).toBe(true);
      expect(listing.key).toBe(`lun:${raw.listing_id}`);
    }
  });

  it("перший запис розкладено поле за полем", () => {
    const { listing, contact } = lunToListing(rawById("lun-479702"), opts);
    expect(listing).toMatchObject({
      key: "lun:lun-479702",
      source: "lun",
      externalId: "lun-479702",
      price: { amount: 15000, currency: "UAH" },
      priceUah: 15000,
      rooms: 2,
      areaM2: 65,
      floor: 1, // з рядка "1/10"
      totalFloors: 10,
      district: "shevchenkivskyi", // з "Шевченківський район"
      petsAllowed: false,
      amenities: ["balcony", "washing_machine"],
      availableFrom: "2026-12-02",
      postedAt: "2026-11-12T03:00:00.000Z",
      commuteMin: 25,
    });
    expect(contact).toEqual({ listingKey: "lun:lun-479702", name: "Ірина", phone: "+380 67 870 36 25" });
  });

  it("ціна лише в доларах → priceUah за курсом, валюта USD", () => {
    const usdKeys = traps.usd.filter((k) => k.startsWith("lun:"));
    expect(usdKeys.length).toBeGreaterThan(0);
    for (const raw of lun) {
      const { listing } = lunToListing(raw, opts);
      if (usdKeys.includes(listing.key)) {
        expect(listing.price).toEqual({ amount: raw.price_usd, currency: "USD" });
        expect(listing.priceUah).toBe(Math.round(raw.price_usd! * traps.fxUsdUah));
      }
    }
  });

  it("немає жодної ціни — AdapterError (схема ЛУН це дозволяє, а Listing — ні)", () => {
    const raw = rawById("lun-479702");
    raw.price_uah = null;
    raw.price_usd = null;
    expect(() => lunToListing(raw, opts)).toThrow(AdapterError);
  });

  it("невідомий район — AdapterError з ключем запису", () => {
    const raw = rawById("lun-479702");
    raw.district_name = "Пустомитівський район";
    expect(() => lunToListing(raw, opts)).toThrow(/lun:lun-479702/);
  });
});
