import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { AuthEnv, RUNTIME_ISSUER, buildServerAuth, debugHeaderAuth } from "../src/index.ts";

/** Як сервер збирає автентифікацію з env. За замовчуванням — JWT; заглушка лише явно. */
describe("AuthEnv", () => {
  it("за замовчуванням AUTH_MODE=jwt, IdP — локальний Keycloak", () => {
    expect(AuthEnv.parse({})).toEqual({ AUTH_MODE: "jwt", IDP_ISSUER: "http://127.0.0.1:8080/realms/relocation-sandbox" });
  });
});

describe("buildServerAuth", () => {
  it("AUTH_MODE=debug → заглушка з заголовків (лише для Inspector і тестів)", () => {
    const auth = buildServerAuth(AuthEnv.parse({ AUTH_MODE: "debug" }), "/nowhere", "mcp-relocation");
    expect(auth.mcp).toBe(debugHeaderAuth);
    expect(auth.debug).toBe(true);
  });

  it("jwt без файлу ключів runtime → помилка на старті з підказкою", () => {
    expect(() => buildServerAuth(AuthEnv.parse({}), join(tmpdir(), "no-such-repo"), "mcp-relocation")).toThrow(/sts:keygen/);
  });

  it("jwt: токен, підписаний ключем runtime, приймається з правильним aud", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-"));
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, ".secrets"));
    writeFileSync(join(root, ".secrets", "runtime-sts.jwks.json"), JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", kid: "k1" }] }));
    const auth = buildServerAuth(AuthEnv.parse({}), root, "mcp-listings");
    const t = await new SignJWT({ sub: "olena" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(RUNTIME_ISSUER).setAudience("mcp-listings").setExpirationTime("5m").sign(privateKey);
    expect(await auth.mcp(new Headers({ authorization: `Bearer ${t}` }))).toEqual({ sub: "olena" });
    expect(auth.debug).toBe(false);
  });
});
