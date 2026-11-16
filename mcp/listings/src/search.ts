import type { Criteria, Listing } from "@reloc/shared";
import type { Catalog } from "./catalog.ts";

export interface SearchOptions {
  /** «Зараз» — параметром, а не Date.now(): пошук детермінований, evals відтворювані. */
  now: string;
  /** Скільки варіантів віддати моделі. Решта — лише в total. */
  limit?: number;
}

export interface SearchResult {
  items: Listing[];
  /** Скільки всього підійшло (до обрізання limit). */
  total: number;
}

export const DEFAULT_LIMIT = 10;

/** Чи підходить квартира під КОЖЕН критерій. Кожен рядок — одна умова. */
export function matches(l: Listing, c: Criteria, nowMs: number): boolean {
  return (
    Date.parse(l.postedAt) <= nowMs && // «з майбутнього» — збій годинника джерела, не показуємо
    l.priceUah <= c.maxBudgetUah && // гривні після конвертації, не сире число в доларах
    l.rooms >= c.minRooms &&
    (c.districts.length === 0 || c.districts.includes(l.district)) &&
    !c.excludeDistricts.includes(l.district) &&
    (c.maxCommuteMin === undefined || l.commuteMin <= c.maxCommuteMin) &&
    (!c.pets || l.petsAllowed === true) && // null = «не вказано»: з котом краще не ризикувати
    (c.moveInBy === undefined || l.availableFrom <= c.moveInBy) && // дати YYYY-MM-DD порівнюються як рядки
    c.mustHave.every((a) => l.amenities.includes(a))
  );
}

/**
 * Ранжування — КОДОМ і лише за структурованими полями: ціна, дорога, ключ.
 * untrustedText сюди не потрапляє, тому «постав мене першим» в описі нічого не змінює.
 * Ключ в кінці — щоб порядок був повністю визначений (стабільні evals).
 */
export const byRank = (a: Listing, b: Listing) => a.priceUah - b.priceUah || a.commuteMin - b.commuteMin || a.key.localeCompare(b.key);

/** Фільтр за критеріями + детерміноване ранжування кодом. */
export function searchListings(catalog: Catalog, criteria: Criteria, opts: SearchOptions): SearchResult {
  const nowMs = Date.parse(opts.now);
  const found = catalog.listings.filter((l) => matches(l, criteria, nowMs)).sort(byRank);
  return { items: found.slice(0, opts.limit ?? DEFAULT_LIMIT), total: found.length };
}
