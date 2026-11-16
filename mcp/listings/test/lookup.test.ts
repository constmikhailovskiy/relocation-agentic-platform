import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Listing } from "@reloc/shared";
import { buildCatalog } from "../src/catalog.ts";
import { type Availability, ListingsError, checkAvailability, getListing } from "../src/lookup.ts";

/**
 * get_listing і check_availability. Ключ відповідей — traps.stale (вже здано)
 * і traps.duplicates (псевдоніми мають працювати так само, як основні ключі).
 */
const fixtures = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", name), "utf8"));
const traps = fixtures("traps.json") as { now: string; fxUsdUah: number; stale: string[]; duplicates: { olx: string; lun: string }[] };
const catalog = buildCatalog({ olx: fixtures("listings.olx.json"), lun: fixtures("listings.lun.json") }, { fxUsdUah: traps.fxUsdUah });
const availability = fixtures("availability.json") as Availability;
const pair = traps.duplicates[0]!;
const opts = { now: traps.now };

/** Очікуємо саме ListingsError з потрібним кодом — не будь-яку помилку. */
async function expectListingsError(p: Promise<unknown> | (() => unknown), code: ListingsError["code"]) {
  const run = typeof p === "function" ? Promise.resolve().then(p) : p;
  await expect(run).rejects.toBeInstanceOf(ListingsError);
  await expect(run).rejects.toMatchObject({ code });
}

describe("getListing", () => {
  it("за ключем повертає оголошення — рівно поля Listing, без контактів", () => {
    const l = getListing(catalog, pair.olx);
    expect(l.key).toBe(pair.olx);
    expect(Object.keys(l).sort()).toEqual(Object.keys(Listing.shape).sort());
  });

  it("за псевдонімом (ключ ЛУН-дубля) повертає квартиру, що лишилась", () => {
    expect(getListing(catalog, pair.lun).key).toBe(pair.olx);
  });

  it("невідомий ключ — not_found, і повторювати немає сенсу", async () => {
    await expectListingsError(() => getListing(catalog, "olx:1"), "not_found");
    expect(() => getListing(catalog, "olx:1")).toThrow(expect.objectContaining({ retryable: false }));
  });
});

describe("checkAvailability", () => {
  it("усі застарілі з traps.stale — rented, з часом перевірки", async () => {
    for (const key of traps.stale) {
      expect(await checkAvailability(catalog, availability, key, opts)).toEqual({ key, status: "rented", checkedAt: traps.now });
    }
  });

  it("звичайне оголошення — available", async () => {
    expect((await checkAvailability(catalog, availability, pair.olx, opts)).status).toBe("available");
  });

  it("за псевдонімом відповідає канонічним ключем", async () => {
    expect((await checkAvailability(catalog, availability, pair.lun, opts)).key).toBe(pair.olx);
  });

  it("здано на іншому сайті — здано: rented у ЛУН-копії видно через OLX-ключ", async () => {
    const result = await checkAvailability(catalog, { [pair.lun]: "rented" }, pair.olx, opts);
    expect(result.status).toBe("rented");
  });

  it("невідомий ключ — not_found", async () => {
    await expectListingsError(checkAvailability(catalog, availability, "lun:nope", opts), "not_found");
  });
});

describe("checkAvailability: хаос (LISTINGS_429_RATE, LISTINGS_LATENCY_MS)", () => {
  const noSleep = async () => {};

  it("random нижче за rate429 → rate_limited, retryable, з підказкою, коли повторити", async () => {
    const p = checkAvailability(catalog, availability, pair.olx, { ...opts, chaos: { rate429: 0.5 }, random: () => 0.1, sleep: noSleep });
    await expectListingsError(p, "rate_limited");
    await expect(p).rejects.toMatchObject({ retryable: true, retryAfterMs: expect.any(Number) });
  });

  it("random вище за rate429 → звичайна відповідь", async () => {
    const r = await checkAvailability(catalog, availability, pair.olx, { ...opts, chaos: { rate429: 0.5 }, random: () => 0.9, sleep: noSleep });
    expect(r.status).toBe("available");
  });

  it("затримка: перед відповіддю чекаємо latencyMs", async () => {
    const waited: number[] = [];
    const sleep = async (ms: number) => {
      waited.push(ms);
    };
    await checkAvailability(catalog, availability, pair.olx, { ...opts, chaos: { latencyMs: 4000 }, sleep });
    expect(waited).toEqual([4000]);
  });

  it("без хаосу — без затримки й без 429", async () => {
    const waited: number[] = [];
    await checkAvailability(catalog, availability, pair.olx, { ...opts, random: () => 0, sleep: async (ms) => void waited.push(ms) });
    expect(waited).toEqual([]);
  });
});
