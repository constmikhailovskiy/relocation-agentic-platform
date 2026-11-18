import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { type Authenticate, jwtAuth } from "../src/auth.ts";

/**
 * Перевірка JWT для MCP-серверів. Ключі генеруємо в тесті — Keycloak і runtime для цього не потрібні:
 * перевіряльнику байдуже, хто підписав, аби ключ був у довіреному JWKS.
 */
const NOW = new Date("2026-11-18T10:00:00Z");
let runtimeKey: webcrypto.CryptoKey;
let otherKey: webcrypto.CryptoKey;
let relocationAuth: Authenticate;
let idpAuth: Authenticate;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const runtime = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  runtimeKey = runtime.privateKey;
  otherKey = other.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(runtime.publicKey)), kid: "rt-1", alg: "ES256" }] });
  relocationAuth = jwtAuth({ issuer: "reloc-runtime", audience: "mcp-relocation", keys: jwks, now: () => NOW });
  idpAuth = jwtAuth({ issuer: "http://idp.test/realms/relocation-sandbox", audience: "mcp-relocation", keys: jwks, subjectClaim: "preferred_username", now: () => NOW });
});

async function token(claims: Record<string, unknown>, opts: { key?: webcrypto.CryptoKey; iss?: string; aud?: string; exp?: Date; alg?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "ES256", kid: "rt-1" })
    .setIssuer(opts.iss ?? "reloc-runtime")
    .setAudience(opts.aud ?? "mcp-relocation")
    .setIssuedAt(Math.floor(NOW.getTime() / 1000))
    .setExpirationTime(opts.exp ?? new Date(NOW.getTime() + 5 * 60_000))
    .sign(opts.key ?? runtimeKey);
}
const bearer = (t: string) => new Headers({ authorization: `Bearer ${t}` });

describe("jwtAuth: делегований токен від runtime", () => {
  it("sub — людина, act — агент, run_id — запуск", async () => {
    const t = await token({ sub: "olena", act: { sub: "agent:concierge@7" }, run_id: "run-1" });
    expect(await relocationAuth(bearer(t))).toEqual({ sub: "olena", act: { sub: "agent:concierge@7" }, runId: "run-1" });
  });

  it("без act — людина напряму", async () => {
    expect(await relocationAuth(bearer(await token({ sub: "olena" })))).toEqual({ sub: "olena" });
  });
});

describe("jwtAuth: відмови (усі → undefined, сервер відповість 401)", () => {
  it.each([
    ["немає заголовка", () => Promise.resolve(new Headers())],
    ["не Bearer", () => Promise.resolve(new Headers({ authorization: "Basic b2xlbmE6eA==" }))],
    ["сміття замість токена", () => Promise.resolve(bearer("not.a.jwt"))],
    ["чужий ключ підпису", async () => bearer(await token({ sub: "olena" }, { key: otherKey }))],
    ["токен для listings (aud) на relocation", async () => bearer(await token({ sub: "olena" }, { aud: "mcp-listings" }))],
    ["чужий видавець (iss)", async () => bearer(await token({ sub: "olena" }, { iss: "evil" }))],
    ["прострочений (exp у минулому)", async () => bearer(await token({ sub: "olena" }, { exp: new Date(NOW.getTime() - 1000) }))],
    ["без sub", async () => bearer(await token({ act: { sub: "agent:x" } }))],
    ["заглушка x-debug-sub у JWT-режимі не діє", () => Promise.resolve(new Headers({ "x-debug-sub": "olena" }))],
  ])("%s", async (_what, headers) => {
    expect(await relocationAuth(await headers())).toBeUndefined();
  });

  it("alg: none (непідписаний токен) → відмова: алгоритм закріплений", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "none" })}.${enc({ sub: "olena", iss: "reloc-runtime", aud: "mcp-relocation", exp: NOW.getTime() / 1000 + 60 })}.`;
    expect(await relocationAuth(bearer(unsigned))).toBeUndefined();
  });

  it("годинник — інʼєкція: той самий токен через 6 хвилин уже недійсний", async () => {
    const t = await token({ sub: "olena" });
    const at = (ms: number) => jwtAuth({ issuer: "reloc-runtime", audience: "mcp-relocation", keys: jwks, now: () => new Date(NOW.getTime() + ms) });
    expect(await at(4 * 60_000)(bearer(t))).toEqual({ sub: "olena" });
    expect(await at(6 * 60_000)(bearer(t))).toBeUndefined();
  });
});

describe("jwtAuth: токен від IdP (Keycloak)", () => {
  it("sub в IdP — UUID; ідентифікатор працівника береться з preferred_username", async () => {
    const t = await token({ sub: "5f1c-uuid", preferred_username: "olena" }, { iss: "http://idp.test/realms/relocation-sandbox" });
    expect(await idpAuth(bearer(t))).toEqual({ sub: "olena" });
  });
});
