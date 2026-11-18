import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type JWTVerifyGetKey, createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { principalFromHeaders } from "./auth-stub.ts";
import type { Principal } from "./policy.ts";

/** Як сервер дізнається, хто питає. Не вдалося — undefined → 401. Сервер отримує цю функцію ззовні (ін'єкція). */
export type Authenticate = (headers: Headers) => Promise<Principal | undefined>;

export interface JwtAuthOptions {
  /** Кому довіряємо: runtime (делеговані токени) або IdP (Keycloak, токени людей). */
  issuer: string;
  /** Для кого токен: "mcp-relocation", "mcp-listings". Токен для listings не відкриє relocation. */
  audience: string;
  /** Публічні ключі видавця (JWKS): локальний файл або URL Keycloak. */
  keys: JWTVerifyGetKey;
  /**
   * Закріплені алгоритми. Без цього можлива атака «alg: none» або підміна асиметричного алгоритму на HS256
   * з публічним ключем у ролі секрету.
   */
  algorithms?: string[];
  /** Звідки брати ідентифікатор працівника. Keycloak: sub — UUID, тож preferred_username. */
  subjectClaim?: string;
  /** Годинник для exp/nbf — справжній. *_NOW з демо сюди не йде: він для бізнес-логіки, не для безпеки. */
  now?: () => Date;
}

/**
 * Перевірка `Authorization: Bearer <JWT>`: підпис, iss, aud, exp, алгоритм. Будь-яка помилка → undefined,
 * без пояснень назовні (причину пише лог сервера, а не відповідь зловмиснику).
 */
export function jwtAuth(opts: JwtAuthOptions): Authenticate {
  const { issuer, audience, keys, algorithms = ["ES256", "RS256"], subjectClaim = "sub", now } = opts;
  return async (headers) => {
    const m = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "");
    if (!m) return undefined;
    try {
      const { payload } = await jwtVerify(m[1]!, keys, { issuer, audience, algorithms, ...(now && { currentDate: now() }) });
      const sub = payload[subjectClaim];
      if (typeof sub !== "string" || sub === "") return undefined;
      const act = (payload.act as { sub?: unknown } | undefined)?.sub;
      const runId = payload.run_id;
      return {
        sub,
        ...(typeof act === "string" && { act: { sub: act } }),
        ...(typeof runId === "string" && { runId }),
      };
    } catch {
      return undefined;
    }
  };
}

/**
 * Заглушка етапів 2–3 (x-debug-sub / x-debug-act) у форматі Authenticate.
 * Лише для тестів і MCP Inspector: сервер вмикає її тільки з AUTH_MODE=debug.
 */
export const debugHeaderAuth: Authenticate = async (headers) => principalFromHeaders(headers);

/** Видавець делегованих токенів — runtime як внутрішній STS (варіант B з ADR 0002). */
export const RUNTIME_ISSUER = "reloc-runtime";

const emptyAsUndefined = (v: unknown) => (v === "" ? undefined : v);

/** Змінні автентифікації, спільні для обох MCP-серверів. */
export const AuthEnv = z.object({
  /** jwt — за замовчуванням. debug — заглушка x-debug-sub (лише MCP Inspector і локальні експерименти). */
  AUTH_MODE: z.enum(["jwt", "debug"]).default("jwt"),
  /** Публічні ключі runtime (JWKS). Відносний шлях — від кореня репо. За замовчуванням .secrets/runtime-sts.jwks.json. */
  RUNTIME_JWKS_PATH: z.preprocess(emptyAsUndefined, z.string().optional()),
  /** Realm Keycloak: звідси токени людей (підтвердження перегляду). */
  IDP_ISSUER: z.url().default("http://127.0.0.1:8080/realms/relocation-sandbox"),
});
export type AuthEnv = z.output<typeof AuthEnv>;

export interface ServerAuth {
  mcp: Authenticate;
  human: Authenticate;
  debug: boolean;
}

/**
 * Зібрати автентифікацію сервера з env. Дві довіри:
 *  - mcp: лише runtime (локальний JWKS з файлу; приватний ключ сервер не бачить);
 *  - human: лише IdP (JWKS тягнемо з Keycloak і кешуємо; ключі ротуються без перезапуску).
 */
export function buildServerAuth(env: AuthEnv, repoRoot: string, audience: string): ServerAuth {
  if (env.AUTH_MODE === "debug") return { mcp: debugHeaderAuth, human: debugHeaderAuth, debug: true };

  const raw = env.RUNTIME_JWKS_PATH ?? ".secrets/runtime-sts.jwks.json";
  const path = isAbsolute(raw) ? raw : join(repoRoot, raw);
  if (!existsSync(path)) throw new Error(`Немає публічних ключів runtime: ${path}. Згенеруй: pnpm sts:keygen (або AUTH_MODE=debug для Inspector).`);
  const runtimeKeys = createLocalJWKSet(JSON.parse(readFileSync(path, "utf8")) as Parameters<typeof createLocalJWKSet>[0]);
  const idpKeys = createRemoteJWKSet(new URL(`${env.IDP_ISSUER}/protocol/openid-connect/certs`));
  return {
    mcp: jwtAuth({ issuer: RUNTIME_ISSUER, audience, keys: runtimeKeys, algorithms: ["ES256"] }),
    human: jwtAuth({ issuer: env.IDP_ISSUER, audience, keys: idpKeys, algorithms: ["RS256"], subjectClaim: "preferred_username" }),
    debug: false,
  };
}
