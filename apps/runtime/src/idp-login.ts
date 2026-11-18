type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Вхід у Keycloak логіном і паролем (Resource Owner Password grant) — ЛИШЕ для CLI в пісочниці.
 * OAuth 2.1 цей grant прибирає: застосунок бачить пароль. У studio (етап 8) — Authorization Code + PKCE.
 * Повертає access token людини; runtime далі сам перевіряє його підпис (userVerifier), відповіді IdP «на слово» не вірить.
 */
export async function passwordLogin(opts: { issuer: string; clientId: string; username: string; password: string; fetch?: Fetch }): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${opts.issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: opts.clientId, username: opts.username, password: opts.password, scope: "openid" }).toString(),
    });
  } catch {
    throw new Error(`Keycloak недоступний (${opts.issuer}). Запусти: docker compose -f infra/docker-compose.yml up -d keycloak`);
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Вхід ${opts.username} не вдався: ${body.error_description ?? body.error ?? res.status}`);
  }
  return body.access_token;
}
