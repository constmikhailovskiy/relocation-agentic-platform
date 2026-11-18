import { join } from "node:path";
import { RUNTIME_ISSUER, jwtAuth } from "@reloc/shared";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { loadAgentSpec } from "../src/spec.ts";
import { assertAudience, createSts, userVerifier } from "../src/sts.ts";

/**
 * Runtime як внутрішній STS (варіант B, ADR 0002):
 *  1) перевірити токен ЛЮДИНИ від IdP → VerifiedUser (лише так, рядок --as не годиться);
 *  2) перевірити, що роль людини є в audience агента;
 *  3) підписати короткий делегований токен: sub = людина, act = агент, aud = конкретний сервер, run_id.
 */
const IDP = "http://idp.test/realms/relocation-sandbox";
const NOW = new Date("2026-11-18T10:00:00Z");
const spec = loadAgentSpec(join(import.meta.dirname, "..", "..", "..", "agents", "concierge.yaml"));

const idp = await generateKeyPair("RS256");
const runtime = await generateKeyPair("ES256");
const idpKeys = createLocalJWKSet({ keys: [{ ...(await exportJWK(idp.publicKey)), alg: "RS256" }] });
const runtimeKeys = createLocalJWKSet({ keys: [{ ...(await exportJWK(runtime.publicKey)), alg: "ES256", kid: "rt-1" }] });

const verify = userVerifier({ issuer: IDP, audience: "relocation-cli", keys: idpKeys, now: () => NOW });
const idpToken = (username: string, roles: string[], opts: { aud?: string } = {}) =>
  new SignJWT({ preferred_username: username, realm_access: { roles: [...roles, "offline_access"] } })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("f81d4fae-uuid")
    .setIssuer(IDP)
    .setAudience(opts.aud ?? "relocation-cli")
    .setIssuedAt(Math.floor(NOW.getTime() / 1000))
    .setExpirationTime(new Date(NOW.getTime() + 10 * 60_000))
    .sign(idp.privateKey);

describe("userVerifier: токен людини від IdP", () => {
  it("валідний → VerifiedUser: id працівника з preferred_username, ролі з realm_access (лише відомі)", async () => {
    const user = await verify(await idpToken("olena", ["new_hire"]));
    expect(user).toMatchObject({ sub: "olena", roles: ["new_hire"] });
  });

  it("токен не для цього клієнта (aud) → помилка", async () => {
    await expect(verify(await idpToken("olena", ["new_hire"], { aud: "studio" }))).rejects.toThrow(/токен/i);
  });

  it("сміття → помилка", async () => {
    await expect(verify("abc")).rejects.toThrow();
  });
});

describe("assertAudience: агент лише для своєї аудиторії", () => {
  it("Олена (new_hire) і Іван (hiring_manager) — так", async () => {
    expect(() => assertAudience(spec, { sub: "olena", roles: ["new_hire"] })).not.toThrow();
    expect(() => assertAudience(spec, { sub: "ivan", roles: ["hiring_manager"] })).not.toThrow();
  });

  it("Богдан (agent_builder) — ні: Concierge не для нього", () => {
    expect(() => assertAudience(spec, { sub: "bohdan", roles: ["agent_builder"] })).toThrow(/bohdan/);
  });
});

describe("createSts.mint: делегований токен", () => {
  const sts = createSts({ privateKey: runtime.privateKey, kid: "rt-1", now: () => NOW });

  it("сервер relocation приймає його: sub = людина, act = агент, run_id", async () => {
    const user = await verify(await idpToken("olena", ["new_hire"]));
    const t = await sts.mint(user, { agent: "agent:concierge@7", audience: "mcp-relocation", runId: "run-1" });
    const auth = jwtAuth({ issuer: RUNTIME_ISSUER, audience: "mcp-relocation", keys: runtimeKeys, now: () => NOW });
    expect(await auth(new Headers({ authorization: `Bearer ${t}` }))).toEqual({ sub: "olena", act: { sub: "agent:concierge@7" }, runId: "run-1" });
  });

  it("живе 5 хвилин: через 6 — недійсний", async () => {
    const user = await verify(await idpToken("olena", ["new_hire"]));
    const t = await sts.mint(user, { agent: "agent:concierge@7", audience: "mcp-relocation", runId: "run-1" });
    const later = jwtAuth({ issuer: RUNTIME_ISSUER, audience: "mcp-relocation", keys: runtimeKeys, now: () => new Date(NOW.getTime() + 6 * 60_000) });
    expect(await later(new Headers({ authorization: `Bearer ${t}` }))).toBeUndefined();
  });

  it("токен для listings не відкриє relocation (aud)", async () => {
    const user = await verify(await idpToken("olena", ["new_hire"]));
    const t = await sts.mint(user, { agent: "agent:concierge@7", audience: "mcp-listings", runId: "run-1" });
    const auth = jwtAuth({ issuer: RUNTIME_ISSUER, audience: "mcp-relocation", keys: runtimeKeys, now: () => NOW });
    expect(await auth(new Headers({ authorization: `Bearer ${t}` }))).toBeUndefined();
  });
});
