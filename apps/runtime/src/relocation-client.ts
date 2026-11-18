import type { ConfirmFn } from "./hitl.ts";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Клієнт не-MCP маршруту relocation: POST /approvals/:id/confirm.
 * Заголовки — лише x-debug-sub (людина), БЕЗ x-debug-act: підтверджує не агент.
 * Етап 4: тут буде токен самого користувача зі studio, а не підпис runtime, — інакше runtime міг би «підтвердити» сам.
 */
export function relocationConfirmer(opts: { baseUrl: string; sub: string; fetch?: Fetch }): ConfirmFn {
  const doFetch: Fetch = opts.fetch ?? fetch;
  return async (approvalId, argsHash) => {
    const res = await doFetch(`${opts.baseUrl}/approvals/${encodeURIComponent(approvalId)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-debug-sub": opts.sub },
      body: JSON.stringify({ argsHash }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (res.ok) return { ok: true, data: body };
    return { ok: false, code: body.error?.code ?? `http_${res.status}`, message: body.error?.message ?? res.statusText };
  };
}
