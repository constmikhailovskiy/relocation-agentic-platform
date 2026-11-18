import { type AgentSpec, RUNTIME_ISSUER, Role } from "@reloc/shared";
import { type JWTVerifyGetKey, SignJWT, jwtVerify } from "jose";

/**
 * «Бренд»: унікальний символ, який знає лише цей модуль. Об'єкт з таким полем можна створити тільки тут,
 * у userVerifier, — тобто ПІСЛЯ перевірки підпису. Рядок `--as olena` у VerifiedUser не перетвориш:
 * TypeScript не дасть передати в mint щось інше.
 */
declare const verified: unique symbol;

export interface VerifiedUser {
  /** Ідентифікатор працівника (preferred_username у Keycloak; sub там — UUID). */
  readonly sub: string;
  readonly roles: readonly Role[];
  readonly [verified]: true;
}

export interface UserVerifierOptions {
  /** Realm Keycloak. */
  issuer: string;
  /** Клієнт, для якого виданий токен людини: "relocation-cli" (етап 8 — "studio"). */
  audience: string;
  keys: JWTVerifyGetKey;
  now?: () => Date;
}

/** Перевірити токен людини від IdP. Невалідний — виняток: без людини агент не стартує. */
export function userVerifier(opts: UserVerifierOptions): (token: string) => Promise<VerifiedUser> {
  return async (token) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, opts.keys, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: ["RS256"],
        ...(opts.now && { currentDate: opts.now() }),
      }));
    } catch (e) {
      throw new Error(`Невалідний токен користувача: ${(e as Error).message}`);
    }
    const sub = payload.preferred_username;
    if (typeof sub !== "string" || sub === "") throw new Error("Невалідний токен користувача: немає preferred_username");
    // Ролі — групи/ролі realm у Keycloak. Беремо лише відомі нам; службові (offline_access…) відкидаємо.
    const raw = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    const roles = (Array.isArray(raw) ? raw : []).filter((r): r is Role => Role.safeParse(r).success);
    return { sub, roles } as unknown as VerifiedUser;
  };
}

/** Агент доступний лише своїй аудиторії зі специфікації (Concierge — не для agent_builder чи auditor). */
export function assertAudience(spec: AgentSpec, user: { sub: string; roles: readonly string[] }): void {
  if (!user.roles.some((r) => (spec.audience.roles as readonly string[]).includes(r))) {
    throw new Error(`Агент ${spec.id} недоступний для ${user.sub} (ролі: ${user.roles.join(", ") || "немає"})`);
  }
}

export interface StsOptions {
  /** Приватний ключ runtime. Лежить лише в runtime; сервери мають тільки публічний (JWKS). */
  privateKey: Parameters<SignJWT["sign"]>[0];
  kid: string;
  ttlSec?: number;
  now?: () => Date;
}

/**
 * Внутрішній STS: обмін «перевірена людина + агент + запуск» на короткий токен для ОДНОГО сервера.
 * Токен людини далі не пересилаємо (token passthrough специфікація MCP забороняє): сервер бачить
 * лише вузький токен з aud саме для нього.
 */
export function createSts(opts: StsOptions) {
  const ttl = opts.ttlSec ?? 300;
  const now = opts.now ?? (() => new Date());
  return {
    mint(user: VerifiedUser, p: { agent: string; audience: string; runId: string }): Promise<string> {
      const iat = Math.floor(now().getTime() / 1000);
      return new SignJWT({ act: { sub: p.agent }, run_id: p.runId })
        .setProtectedHeader({ alg: "ES256", kid: opts.kid })
        .setIssuer(RUNTIME_ISSUER)
        .setSubject(user.sub)
        .setAudience(p.audience)
        .setIssuedAt(iat)
        .setExpirationTime(iat + ttl)
        .sign(opts.privateKey);
    },
  };
}

/**
 * authHeaders для connectTools: на КОЖЕН запит — свіжий токен з aud конкретного сервера
 * ("relocation" → "mcp-relocation") і run_id поточного ходу (його оновлює сесія через `current`).
 */
export function delegatedAuthHeaders(
  sts: ReturnType<typeof createSts>,
  user: VerifiedUser,
  agent: string,
  current: { runId: string },
): (server: string) => Promise<Record<string, string>> {
  return async (server) => ({
    authorization: `Bearer ${await sts.mint(user, { agent, audience: `mcp-${server}`, runId: current.runId || "connect" })}`,
  });
}
