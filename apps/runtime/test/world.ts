import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog } from "../../../mcp/listings/src/catalog.ts";
import { createListingsApp } from "../../../mcp/listings/src/http.ts";
import type { Availability } from "../../../mcp/listings/src/lookup.ts";
import type { AuditEvent } from "../../../mcp/relocation/src/context.ts";
import { createRelocationApp } from "../../../mcp/relocation/src/http.ts";
import { RelocationStore } from "../../../mcp/relocation/src/store.ts";

/**
 * Обидва справжні MCP-сервери в пам'яті, без портів: клієнтський транспорт SDK шле запити в `app.request`.
 * «Зараз» — з фікстур (traps.json), однакове для обох серверів, як у живому демо.
 */
const fixtures = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", name), "utf8"));
const traps = fixtures("traps.json") as { now: string; fxUsdUah: number };
export const WORLD_NOW = traps.now;

const catalog = buildCatalog({ olx: fixtures("listings.olx.json") as unknown[], lun: fixtures("listings.lun.json") as unknown[] }, { fxUsdUah: traps.fxUsdUah });

export function world() {
  const store = RelocationStore.fromSeed({ searches: fixtures("searches.json"), employees: fixtures("employees.json") });
  const audit: AuditEvent[] = [];
  const relocation = createRelocationApp({ store, now: () => WORLD_NOW, audit: (e) => audit.push(e) });
  const listings = createListingsApp({ catalog, availability: fixtures("availability.json") as Availability, now: () => WORLD_NOW });
  /** fetch, що розводить запити між двома застосунками за хостом. Те саме, що мережа, але в пам'яті. */
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(url instanceof Request ? url.url : url);
    const app = u.host === "listings.test" ? listings : u.host === "relocation.test" ? relocation : undefined;
    if (!app) throw new Error(`Невідомий хост у тесті: ${u.host}`);
    return app.request(url, init);
  };
  return {
    store,
    audit,
    fetch,
    urls: { listings: "http://listings.test/mcp", relocation: "http://relocation.test/mcp" },
    relocationBaseUrl: "http://relocation.test",
  };
}
