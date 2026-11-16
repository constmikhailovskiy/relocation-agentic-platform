import type { Listing } from "@reloc/shared";

export interface Deduped {
  /** Унікальні квартири: по одному запису на квартиру. */
  listings: Listing[];
  /** Ключ дубля → ключ запису, який лишився. get_listing("lun:...") знайде квартиру через нього. */
  aliasOf: Map<string, string>;
}

/** «  вул.   Валова, 120 » і «вул. Валова, 120» — та сама вулиця. */
const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Відбиток квартири: те, що не змінюється між сайтами. Ціни тут немає навмисно:
 * той самий власник на різних сайтах може просити різну суму (у фікстурах — +500 грн на ЛУН).
 */
export const fingerprint = (l: Listing) => [l.district, normalize(l.street), l.rooms, l.areaM2, l.floor].join("|");

/** Хто «оригінал»: раніше опублікований. При однаковому часі — менший ключ, щоб результат не залежав від порядку. */
const isEarlier = (a: Listing, b: Listing) => {
  const ta = Date.parse(a.postedAt);
  const tb = Date.parse(b.postedAt);
  return ta < tb || (ta === tb && a.key < b.key);
};

/** Та сама квартира на кількох сайтах → один запис. */
export function dedupe(listings: Listing[]): Deduped {
  // Прохід 1: для кожного відбитка знаходимо переможця — найранішу копію.
  const winners = new Map<string, Listing>();
  for (const l of listings) {
    const fp = fingerprint(l);
    const current = winners.get(fp);
    if (current === undefined || isEarlier(l, current)) winners.set(fp, l);
  }

  // Прохід 2: кожен, хто не переміг, стає псевдонімом переможця.
  const aliasOf = new Map<string, string>();
  for (const l of listings) {
    const winner = winners.get(fingerprint(l));
    if (winner !== undefined && winner.key !== l.key) aliasOf.set(l.key, winner.key);
  }

  return { listings: [...winners.values()], aliasOf };
}
