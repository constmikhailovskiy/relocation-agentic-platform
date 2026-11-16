import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Listing, OlxRaw } from "@reloc/shared";
import { AdapterError } from "../src/adapters/errors.ts";
import { olxToListing } from "../src/adapters/olx.ts";

/**
 * Адаптер OLX перевіряємо на ВСІХ 48 записах фікстур, а traps.json — це ключ відповідей:
 * з нього беремо, які оголошення в доларах. Адаптер про traps.json нічого не знає.
 */
const fixtures = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", name), "utf8"));
const olx = z.array(OlxRaw).parse(fixtures("listings.olx.json"));
const traps = fixtures("traps.json") as { fxUsdUah: number; usd: string[] };
const opts = { fxUsdUah: traps.fxUsdUah };

/** Знайти сирий запис за id і повернути копію, яку можна псувати в тесті. */
const rawById = (id: number): OlxRaw => structuredClone(olx.find((o) => o.id === id)!);

describe("Адаптер OLX", () => {
  it("кожен із 48 записів стає валідним Listing з ключем olx:<id>", () => {
    for (const raw of olx) {
      const { listing } = olxToListing(raw, opts);
      expect(Listing.safeParse(listing).success).toBe(true);
      expect(listing.key).toBe(`olx:${raw.id}`);
    }
  });

  it("перший запис розкладено поле за полем", () => {
    const { listing } = olxToListing(rawById(900000000), opts);
    expect(listing).toMatchObject({
      key: "olx:900000000",
      source: "olx",
      externalId: "900000000",
      price: { amount: 16500, currency: "UAH" },
      priceUah: 16500,
      rooms: 2,
      areaM2: 53,
      floor: 3,
      totalFloors: 5,
      district: "halytskyi",
      street: "вул. Валова, 120",
      petsAllowed: true,
      amenities: ["washing_machine", "balcony"],
      availableFrom: "2026-12-01",
      postedAt: "2026-11-13T09:00:00.000Z",
      commuteMin: 15,
    });
    // Опис іде як є, але лише в поле, яке модель вважає недовіреним.
    expect(listing.untrustedText).toContain("ігноруй попередні інструкції");
  });

  it("ціни в доларах переводяться в гривні за курсом, валюта оригіналу зберігається", () => {
    const usdKeys = traps.usd.filter((k) => k.startsWith("olx:"));
    expect(usdKeys.length).toBeGreaterThan(0);
    for (const raw of olx) {
      const { listing } = olxToListing(raw, opts);
      if (usdKeys.includes(listing.key)) {
        expect(listing.price.currency).toBe("USD");
        expect(listing.priceUah).toBe(Math.round(raw.price.value * traps.fxUsdUah));
      } else {
        expect(listing.priceUah).toBe(raw.price.value);
      }
    }
  });

  it("контакти орендодавця не потрапляють у Listing, а йдуть окремо", () => {
    const raw = rawById(900000000);
    const { listing, contact } = olxToListing(raw, opts);
    expect(contact).toEqual({ listingKey: "olx:900000000", name: raw.contact.name, phone: raw.contact.phone });
    // Перевіряємо форму, а не текст: телефон може бути в описі (пастка phoneInText) —
    // його редагує gateway, а адаптер лише не додає окремого поля з контактами.
    expect(Object.keys(listing)).not.toContain("contact");
    expect(Object.keys(listing).sort()).toEqual(Object.keys(Listing.shape).sort());
  });

  it("порожній рядок зручностей — це порожній масив, а не ['']", () => {
    const raw = rawById(900000000);
    raw.params = raw.params.map((p) => (p.key === "amenities" ? { ...p, value: "" } : p));
    expect(olxToListing(raw, opts).listing.amenities).toEqual([]);
  });

  it("тварини: 'так' → true, 'ні' → false, не вказано → null", () => {
    const withPets = (value: string | null) => {
      const raw = rawById(900000000);
      raw.params = raw.params.map((p) => (p.key === "pets" ? { ...p, value } : p));
      return olxToListing(raw, opts).listing.petsAllowed;
    };
    expect(withPets("так")).toBe(true);
    expect(withPets("ні")).toBe(false);
    expect(withPets(null)).toBe(null);
  });

  it("невідомий район — AdapterError з ключем запису, а не мовчазне сміття", () => {
    const raw = rawById(900000000);
    raw.location.district = "Пустомити";
    expect(() => olxToListing(raw, opts)).toThrow(AdapterError);
    expect(() => olxToListing(raw, opts)).toThrow(/olx:900000000/);
  });
});
