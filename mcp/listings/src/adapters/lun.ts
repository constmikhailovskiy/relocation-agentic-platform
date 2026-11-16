import { COMMUTE_MIN, type LunRaw, type Money, districtFromUk, listingKey } from "@reloc/shared";
import { type AdapterOptions, type Adapted, finalize, parseAmenities, toUah } from "./common.ts";
import { AdapterError } from "./errors.ts";

/** Сирий запис ЛУН → нормалізоване оголошення + контакти орендодавця. */
export function lunToListing(raw: LunRaw, opts: AdapterOptions): Adapted {
  const key = listingKey("lun", raw.listing_id);
  const fail = (reason: string): never => {
    throw new AdapterError(key, reason);
  };

  // «Шевченківський район» → shevchenkivskyi (districtFromUk сам відкидає слово «район»).
  const district = districtFromUk(raw.district_name) ?? fail(`невідомий район «${raw.district_name}»`);

  // Ціна у двох полях. Гривня — пріоритетна: це ціна, яку назвав власник, без перерахунку.
  const price: Money =
    raw.price_uah !== null ? { amount: raw.price_uah, currency: "UAH" }
    : raw.price_usd !== null ? { amount: raw.price_usd, currency: "USD" }
    : fail("немає ні ціни в гривнях, ні в доларах");

  // "1/10" → [1, 10]. Через noUncheckedIndexedAccess елементи мають тип number | undefined.
  const [floor, totalFloors] = raw.floor.split("/").map(Number);

  return finalize(key, {
    key,
    source: "lun",
    externalId: raw.listing_id,
    url: raw.link,
    title: raw.headline,
    price,
    priceUah: toUah(price.amount, price.currency, opts.fxUsdUah),
    rooms: raw.rooms,
    areaM2: raw.area,
    floor: floor ?? fail(`не вдалося розібрати поверх «${raw.floor}»`),
    totalFloors: totalFloors ?? fail(`не вдалося розібрати поверх «${raw.floor}»`),
    district,
    street: raw.street,
    petsAllowed: raw.pets_ok, // ЛУН уже дає boolean | null — перекладати нічого
    amenities: parseAmenities(raw.features),
    availableFrom: raw.available_from,
    postedAt: raw.published_at,
    commuteMin: COMMUTE_MIN[district],
    untrustedText: raw.text,
  }, { name: raw.owner.name, phone: raw.owner.tel });
}
