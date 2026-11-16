import { type LandlordContact, type Listing, LunRaw, OlxRaw, type Source } from "@reloc/shared";
import type { z } from "zod";
import type { AdapterOptions, Adapted } from "./adapters/common.ts";
import { AdapterError } from "./adapters/errors.ts";
import { lunToListing } from "./adapters/lun.ts";
import { olxToListing } from "./adapters/olx.ts";
import { dedupe } from "./dedupe.ts";

/** Каталог — усе, що сервер listings знає про оголошення після завантаження джерел. */
export interface Catalog {
  /** Унікальні квартири (після дедуплікації). Це бачить модель. */
  listings: Listing[];
  /** Ключ дубля → ключ квартири, що лишилась. */
  aliasOf: Map<string, string>;
  /** Контакти за ключем квартири. Моделі не віддаються — лише request_viewing після HITL. */
  contacts: Map<string, LandlordContact>;
  /** Пропущені биті записи: що і чому. Для логів і метрик, не для моделі. */
  skipped: { key: string; reason: string }[];
}

/** Сирі записи від джерел. `unknown`, бо це зовнішні дані: довіряти їхній формі не можна. */
export interface RawSources {
  olx: unknown[];
  lun: unknown[];
}

/** Адаптери можна підмінити в тесті — щоб перевірити, що справжній баг не ховається. */
export interface Adapters {
  olx: (raw: OlxRaw, opts: AdapterOptions) => Adapted;
  lun: (raw: LunRaw, opts: AdapterOptions) => Adapted;
}

export const DEFAULT_ADAPTERS: Adapters = { olx: olxToListing, lun: lunToListing };

type Skipped = Catalog["skipped"];

/**
 * Прогнати записи одного джерела через схему й адаптер.
 * `<Raw>` — generic: функція однакова для OLX і ЛУН, а тип сирого запису виводиться зі схеми.
 *
 * Політика помилок:
 *  - не та форма (схема джерела) → пропустити, ключ `<source>:#<номер>` (id може бути битим);
 *  - AdapterError (форма правильна, але дані безглузді) → пропустити, ключ запису;
 *  - будь-що інше → це баг у НАШОМУ коді: пробрасуємо, щоб він не ховався в лічильнику пропусків.
 */
function adaptAll<Raw>(
  source: Source,
  records: unknown[],
  schema: z.ZodType<Raw>,
  adapt: (raw: Raw, opts: AdapterOptions) => Adapted,
  opts: AdapterOptions,
  skipped: Skipped,
): Adapted[] {
  const out: Adapted[] = [];
  records.forEach((record, i) => {
    const parsed = schema.safeParse(record);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
      skipped.push({ key: `${source}:#${i}`, reason: `не відповідає формату ${source}: ${fields}` });
      return;
    }
    try {
      out.push(adapt(parsed.data, opts));
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      skipped.push({ key: e.key, reason: e.reason });
    }
  });
  return out;
}

export function buildCatalog(raw: RawSources, opts: AdapterOptions, adapters: Adapters = DEFAULT_ADAPTERS): Catalog {
  const skipped: Skipped = [];
  const adapted = [
    ...adaptAll("olx", raw.olx, OlxRaw, adapters.olx, opts, skipped),
    ...adaptAll("lun", raw.lun, LunRaw, adapters.lun, opts, skipped),
  ];

  const { listings, aliasOf } = dedupe(adapted.map((a) => a.listing));

  // Контакти лише тих квартир, що лишились після дедуплікації.
  const contactOf = new Map(adapted.map((a) => [a.listing.key, a.contact]));
  const contacts = new Map<string, LandlordContact>();
  for (const l of listings) {
    const contact = contactOf.get(l.key);
    if (contact !== undefined) contacts.set(l.key, contact);
  }

  return { listings, aliasOf, contacts, skipped };
}
