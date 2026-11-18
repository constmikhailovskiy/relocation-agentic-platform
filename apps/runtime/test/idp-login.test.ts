import { describe, expect, it } from "vitest";
import { passwordLogin } from "../src/idp-login.ts";

/**
 * Вхід у CLI: Resource Owner Password grant у Keycloak. Лише для пісочниці (у проді — Authorization Code + PKCE
 * у studio). Мережі тут немає: fetch підставний.
 */
const ISSUER = "http://127.0.0.1:8080/realms/relocation-sandbox";

describe("passwordLogin", () => {
  it("POST form на token endpoint realm-у; повертає access_token", async () => {
    const seen: { url: string; body: string }[] = [];
    const token = await passwordLogin({
      issuer: ISSUER, clientId: "relocation-cli", username: "olena", password: "pw",
      fetch: async (url, init) => {
        seen.push({ url: String(url), body: String(init?.body) });
        return Response.json({ access_token: "eyJ.x.y", token_type: "Bearer", expires_in: 1800 });
      },
    });
    expect(token).toBe("eyJ.x.y");
    expect(seen[0]!.url).toBe(`${ISSUER}/protocol/openid-connect/token`);
    expect(new URLSearchParams(seen[0]!.body).get("grant_type")).toBe("password");
    expect(new URLSearchParams(seen[0]!.body).get("client_id")).toBe("relocation-cli");
  });

  it("невірний пароль → зрозуміла помилка, пароль у повідомлення не потрапляє", async () => {
    const err = await passwordLogin({
      issuer: ISSUER, clientId: "relocation-cli", username: "olena", password: "s3cret-pw",
      fetch: async () => Response.json({ error: "invalid_grant", error_description: "Invalid user credentials" }, { status: 401 }),
    }).catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/olena/);
    expect(String(err)).not.toContain("s3cret-pw");
  });

  it("Keycloak недоступний → підказка, як його запустити", async () => {
    const err = await passwordLogin({
      issuer: ISSUER, clientId: "relocation-cli", username: "olena", password: "pw",
      fetch: async () => { throw new TypeError("fetch failed"); },
    }).catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/keycloak/i);
  });
});
