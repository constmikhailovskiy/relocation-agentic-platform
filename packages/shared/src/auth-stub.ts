import type { Principal } from "./policy.ts";

/**
 * ЗАГЛУШКА автентифікації (етап 2) для обох MCP-серверів. Principal береться з заголовків —
 * підробити може будь-хто, тому сервери слухають лише 127.0.0.1. Етап 4 замінить цю функцію
 * перевіркою JWT (підпис, aud, sub і act з токена) — в одному місці для обох серверів.
 */
export function principalFromHeaders(headers: Headers): Principal | undefined {
  const sub = headers.get("x-debug-sub");
  if (!sub) return undefined;
  const act = headers.get("x-debug-act");
  return act ? { sub, act: { sub: act } } : { sub };
}
