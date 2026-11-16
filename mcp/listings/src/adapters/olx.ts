import { COMMUTE_MIN, type OlxRaw, districtFromUk, listingKey } from "@reloc/shared";
import { type AdapterOptions, type Adapted, finalize, parseAmenities, toUah } from "./common.ts";
import { AdapterError } from "./errors.ts";

/** Сирий запис OLX → нормалізоване оголошення + контакти орендодавця. */
export function olxToListing(raw: OlxRaw, opts: AdapterOptions): Adapted {
  const key = listingKey("olx", String(raw.id));
  const fail = (reason: string): never => {
    throw new AdapterError(key, reason);
  };

  // OLX тримає атрибути масивом рядків. Дістаємо значення за ключем.
  const param = (k: OlxRaw["params"][number]["key"]) => raw.params.find((p) => p.key === k)?.value ?? null;
  const num = (k: Parameters<typeof param>[0]) => {
    const value = param(k);
    const n = Number(value);
    return value !== null && Number.isFinite(n) ? n : fail(`параметр ${k} відсутній або не число`);
  };

  const district = districtFromUk(raw.location.district) ?? fail(`невідомий район «${raw.location.district}»`);
  const pets = param("pets");
  const amenities = param("amenities");

  return finalize(key, {
    key,
    source: "olx",
    externalId: String(raw.id),
    url: raw.url,
    title: raw.title,
    price: { amount: raw.price.value, currency: raw.price.currency },
    priceUah: toUah(raw.price.value, raw.price.currency, opts.fxUsdUah),
    rooms: num("number_of_rooms"),
    areaM2: num("total_area"),
    floor: num("floor"),
    totalFloors: num("total_floors"),
    district,
    street: raw.location.street,
    petsAllowed: pets === "так" ? true : pets === "ні" ? false : null,
    amenities: amenities ? parseAmenities(amenities.split(",")) : [],
    availableFrom: param("available_from") ?? fail("немає дати заселення"),
    postedAt: raw.created_time,
    commuteMin: COMMUTE_MIN[district],
    untrustedText: raw.description,
  }, raw.contact);
}
