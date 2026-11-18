import { readFileSync } from "node:fs";
import { debugHeaderAuth } from "@reloc/shared";
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
  const relocation = createRelocationApp({ store, now: () => WORLD_NOW, audit: (e) => audit.push(e) }, { mcp: debugHeaderAuth, human: debugHeaderAuth });
  const listings = createListingsApp({ catalog, availability: fixtures("availability.json") as Availability, now: () => WORLD_NOW }, debugHeaderAuth);
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

/**
 * Той самий світ, але в JWT-режимі (етап 4): сервери не вірять x-debug-*.
 *  - runtime-ключ (ES256): ним STS підписує делеговані токени; сервери мають лише публічну частину;
 *  - «IdP»-ключ (RS256): ним підписані токени людей — як у Keycloak;
 *  - годинник спільний і рухомий: перевіряємо exp без sleep.
 */
export async function jwtWorld() {
  const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import("jose");
  const { jwtAuth, RUNTIME_ISSUER } = await import("@reloc/shared");
  const runtime = await generateKeyPair("ES256");
  const idp = await generateKeyPair("RS256");
  const jwks = async (key: Parameters<typeof exportJWK>[0], alg: string) => createLocalJWKSet({ keys: [{ ...(await exportJWK(key)), alg, kid: `${alg}-1` }] });
  const runtimeKeys = await jwks(runtime.publicKey, "ES256");
  const idpKeys = await jwks(idp.publicKey, "RS256");
  const clock = { now: new Date("2026-11-18T10:00:00Z") };
  const now = () => clock.now;
  const IDP_ISSUER = "http://idp.test/realms/relocation-sandbox";

  const store = RelocationStore.fromSeed({ searches: fixtures("searches.json"), employees: fixtures("employees.json") });
  const audit: AuditEvent[] = [];
  const relocation = createRelocationApp(
    { store, now: () => WORLD_NOW, audit: (e) => audit.push(e) },
    {
      mcp: jwtAuth({ issuer: RUNTIME_ISSUER, audience: "mcp-relocation", keys: runtimeKeys, now }),
      human: jwtAuth({ issuer: IDP_ISSUER, audience: "mcp-relocation", keys: idpKeys, subjectClaim: "preferred_username", now }),
    },
  );
  const listings = createListingsApp(
    { catalog, availability: fixtures("availability.json") as Availability, now: () => WORLD_NOW },
    jwtAuth({ issuer: RUNTIME_ISSUER, audience: "mcp-listings", keys: runtimeKeys, now }),
  );
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(url instanceof Request ? url.url : url);
    const app = u.host === "listings.test" ? listings : u.host === "relocation.test" ? relocation : undefined;
    if (!app) throw new Error(`Невідомий хост у тесті: ${u.host}`);
    return app.request(url, init);
  };
  /** Токен людини від «Keycloak»: aud — і runtime-клієнт, і relocation (для підтвердження). Живе годину. */
  const userToken = (username: string, roles: string[]) =>
    new SignJWT({ preferred_username: username, realm_access: { roles } })
      .setProtectedHeader({ alg: "RS256", kid: "RS256-1" })
      .setSubject(`uuid-${username}`)
      .setIssuer(IDP_ISSUER)
      .setAudience(["relocation-cli", "mcp-relocation"])
      .setIssuedAt(Math.floor(clock.now.getTime() / 1000))
      .setExpirationTime(Math.floor(clock.now.getTime() / 1000) + 3600)
      .sign(idp.privateKey);
  return {
    store, audit, fetch, clock, now, userToken, idpKeys, IDP_ISSUER,
    runtimePrivateKey: runtime.privateKey,
    urls: { listings: "http://listings.test/mcp", relocation: "http://relocation.test/mcp" },
    relocationBaseUrl: "http://relocation.test",
  };
}
