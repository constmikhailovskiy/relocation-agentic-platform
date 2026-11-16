import { AMENITY_NAMES_UK, type Amenity, type LandlordContact, Listing } from "@reloc/shared";
import { AdapterError } from "./errors.ts";

/**
 * Спільне для всіх адаптерів джерел. Кожен адаптер знає лише свій сирий формат,
 * а правила «як виглядає готовий запис» живуть тут — в одному місці.
 */

export interface AdapterOptions {
  /** Курс USD→UAH. Параметр, а не глобальна константа: так тести й конфіг керують ним явно. */
  fxUsdUah: number;
}

export interface Adapted {
  listing: Listing;
  /** Контакти — окремо від Listing: моделі вони не віддаються ніколи. */
  contact: LandlordContact;
}

/** «пральна машина» → "washing_machine". Будуємо один раз зі спільного довідника. */
const AMENITY_BY_UK = new Map(Object.entries(AMENITY_NAMES_UK).map(([key, uk]) => [uk, key as Amenity]));

/** Розбір списку зручностей: невідомі слова ігноруємо, порожні рядки відкидаються. */
export function parseAmenities(words: string[]): Amenity[] {
  return words.map((w) => AMENITY_BY_UK.get(w.trim().toLowerCase())).filter((a): a is Amenity => a !== undefined);
}

/** Ціна в гривнях: долари — за курсом, з округленням до цілої гривні. */
export const toUah = (amount: number, currency: "UAH" | "USD", fxUsdUah: number) => (currency === "USD" ? Math.round(amount * fxUsdUah) : amount);

/**
 * Останній бар'єр кожного адаптера: кандидат має пройти схему Listing,
 * інакше — AdapterError з ключем запису. Назовні не виходить запис, що порушує контракт.
 */
export function finalize(key: string, candidate: unknown, contact: { name: string; phone: string }): Adapted {
  const parsed = Listing.safeParse(candidate);
  if (!parsed.success) {
    throw new AdapterError(key, `не відповідає схемі Listing: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  // Після throw вище TypeScript знає: тут parsed.success === true, отже parsed.data — Listing.
  return { listing: parsed.data, contact: { listingKey: key, ...contact } };
}
