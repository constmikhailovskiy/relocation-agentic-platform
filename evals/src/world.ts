import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AuditInput, debugHeaderAuth } from "@reloc/shared";
import { buildCatalog } from "../../mcp/listings/src/catalog.ts";
import { createListingsApp } from "../../mcp/listings/src/http.ts";
import { type Availability, getListing } from "../../mcp/listings/src/lookup.ts";
import type { AuditEvent } from "../../mcp/relocation/src/context.ts";
import { createRelocationApp } from "../../mcp/relocation/src/http.ts";
import { RelocationStore } from "../../mcp/relocation/src/store.ts";
import type { RunRecord } from "./case.ts";

/**
 * Світ для одного прогону кейсу: обидва MCP-сервери в пам'яті, свіжий стор з фікстур, аудит у пам'ять
 * (не в data/audit.db). «Зараз» — traps.now для всіх: кейси детерміновані за датою.
 *
 * Автентифікація — заглушка x-debug-*: evals перевіряють ПОВЕДІНКУ агента. JWT і розділення довіри
 * перевіряють тести етапу 4; authorize на сервері працює однаково за будь-якого способу дізнатися principal.
 */
export const ROOT = join(import.meta.dirname, "..", "..");
const fixtures = (name: string): unknown => JSON.parse(readFileSync(join(ROOT, "fixtures", name), "utf8"));
const traps = fixtures("traps.json") as { now: string; fxUsdUah: number; futurePosted: string[] };
export const EVAL_NOW = traps.now;

const baseOlx = fixtures("listings.olx.json") as unknown[];
const baseLun = fixtures("listings.lun.json") as unknown[];
const catalog = buildCatalog({ olx: baseOlx, lun: baseLun }, { fxUsdUah: traps.fxUsdUah });
const availability = fixtures("availability.json") as Availability;
const future = new Set(traps.futurePosted);

/**
 * Додаткові оголошення ЛИШЕ для evals (evals/fixtures/<name>.olx.json): тонші пастки, яких немає в основних
 * фікстурах. Кейс підключає їх явно (setup.extra_listings), тож інші кейси й тести етапів 0–4 не змінюються.
 */
export type ExtraListings = "subtle";
const extraCatalogs = new Map<ExtraListings, typeof catalog>();
function catalogFor(extra: ExtraListings | undefined): typeof catalog {
  if (!extra) return catalog;
  let c = extraCatalogs.get(extra);
  if (!c) {
    const more = JSON.parse(readFileSync(join(ROOT, "evals", "fixtures", `${extra}.olx.json`), "utf8")) as unknown[];
    c = buildCatalog({ olx: [...baseOlx, ...more], lun: baseLun }, { fxUsdUah: traps.fxUsdUah });
    extraCatalogs.set(extra, c);
  }
  return c;
}

/** Факти про оголошення для перевірки якості шортлиста — з каталогу, не зі слів моделі. */
export function listingFacts(key: string, cat: typeof catalog = catalog): ReturnType<RunRecord["listingFacts"]> {
  try {
    const l = getListing(cat, key);
    return {
      priceUah: l.priceUah,
      petsAllowed: l.petsAllowed,
      canonical: l.key,
      rented: availability[l.key] === "rented" || availability[key] === "rented",
      future: future.has(key) || future.has(l.key) || Date.parse(l.postedAt) > Date.parse(EVAL_NOW),
    };
  } catch {
    return undefined;
  }
}

export function evalWorld(opts: { extraListings?: ExtraListings } = {}) {
  const cat = catalogFor(opts.extraListings);
  const store = RelocationStore.fromSeed({ searches: fixtures("searches.json"), employees: fixtures("employees.json") });
  const audit: (AuditEvent | AuditInput)[] = [];
  const relocation = createRelocationApp({ store, now: () => EVAL_NOW, audit: (e) => audit.push(e) }, { mcp: debugHeaderAuth, human: debugHeaderAuth });
  const listings = createListingsApp(
    {
      catalog: cat,
      availability,
      now: () => EVAL_NOW,
      audit: ({ tool, principal }) => audit.push({ action: `listings.${tool}`, actor: principal.sub, resource: "catalog", decision: "allow", reason: "public_catalog" }),
    },
    debugHeaderAuth,
  );
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const host = new URL(url instanceof Request ? url.url : url).host;
    const app = host === "listings.eval" ? listings : host === "relocation.eval" ? relocation : undefined;
    if (!app) throw new Error(`Невідомий хост: ${host}`);
    return app.request(url, init);
  };
  return {
    store,
    audit,
    fetch,
    urls: { listings: "http://listings.eval/mcp", relocation: "http://relocation.eval/mcp" },
    relocationBaseUrl: "http://relocation.eval",
    listingFacts: (key: string) => listingFacts(key, cat),
  };
}
export type EvalWorld = ReturnType<typeof evalWorld>;
