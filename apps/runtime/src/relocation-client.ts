import type { ConfirmFn } from "./hitl.ts";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Клієнт не-MCP маршруту relocation: POST /approvals/:id/confirm.
 * Заголовки — ЛЮДИНИ (етап 4: `Authorization: Bearer <токен від IdP>`), а не делегований токен агента.
 * Сервер приймає тут лише токени IdP: підписати замінник runtime не може.
 */
export function relocationConfirmer(opts: { baseUrl: string; authHeaders: () => Promise<Record<string, string>>; fetch?: Fetch }): ConfirmFn {
  const doFetch: Fetch = opts.fetch ?? fetch;
  return async (approvalId, argsHash) => {
    const res = await doFetch(`${opts.baseUrl}/approvals/${encodeURIComponent(approvalId)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await opts.authHeaders()) },
      body: JSON.stringify({ argsHash }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (res.ok) return { ok: true, data: body };
    return { ok: false, code: body.error?.code ?? `http_${res.status}`, message: body.error?.message ?? res.statusText };
  };
}
