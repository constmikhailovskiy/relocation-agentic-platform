import type { Listing } from "@reloc/shared";
import type { Catalog } from "./catalog.ts";

/**
 * Помилка сервісу listings, яку можна показати агенту.
 * `retryable` — підказка клієнту (runtime, Temporal): чи є сенс повторити.
 */
export class ListingsError extends Error {
  constructor(
    readonly code: "not_found" | "rate_limited",
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ListingsError";
  }
}

/** Статус оголошення в джерелі: ключ → «вже здано». Чого немає в мапі — ще доступне. */
export type Availability = Record<string, "rented">;

export interface AvailabilityResult {
  /** Канонічний ключ (якщо питали за псевдонімом — ключ квартири, що лишилась). */
  key: string;
  status: "available" | "rented";
  checkedAt: string;
}

export interface CheckOptions {
  now: string;
  /** Хаос для тренування ретраїв: частка відповідей 429 і затримка відповіді джерела. */
  chaos?: { rate429?: number; latencyMs?: number };
  /** Підставляються в тестах, щоб хаос був детермінованим. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Через скільки радимо повторити після 429. */
export const RETRY_AFTER_MS = 1000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Оголошення за ключем або псевдонімом. Без контактів — їх у Listing немає. */
export function getListing(catalog: Catalog, key: string): Listing {
  // Псевдонім → канонічний ключ; звичайний ключ лишається як є (`??` — «якщо зліва undefined»).
  const canonical = catalog.aliasOf.get(key) ?? key;
  const listing = catalog.listings.find((l) => l.key === canonical);
  if (listing === undefined) throw new ListingsError("not_found", `Оголошення ${key} не знайдено`, false);
  return listing;
}

/** Чи ще доступна квартира. Перевіряє всі копії: здано на одному сайті — здано. */
export async function checkAvailability(catalog: Catalog, availability: Availability, key: string, opts: CheckOptions): Promise<AvailabilityResult> {
  const { key: canonical } = getListing(catalog, key); // not_found — одразу, без звернення до «джерела»

  // Далі імітуємо справжнє джерело: воно буває повільним і перевантаженим.
  const { rate429 = 0, latencyMs = 0 } = opts.chaos ?? {};
  if (latencyMs > 0) await (opts.sleep ?? defaultSleep)(latencyMs);
  if (rate429 > 0 && (opts.random ?? Math.random)() < rate429) {
    throw new ListingsError("rate_limited", "Джерело оголошень перевантажене, спробуйте пізніше", true, RETRY_AFTER_MS);
  }

  // Усі копії квартири: сама канонічна + ключі дублів, що на неї вказують.
  const copies = [canonical, ...[...catalog.aliasOf].filter(([, target]) => target === canonical).map(([alias]) => alias)];
  const rented = copies.some((k) => availability[k] === "rented");
  return { key: canonical, status: rented ? "rented" : "available", checkedAt: opts.now };
}
