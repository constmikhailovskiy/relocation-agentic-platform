import type { AssistantMessage } from "./messages.ts";
import { BudgetExceededError, type CallModel } from "./model.ts";

export interface GatewayModelOptions {
  baseUrl: string;
  /** Ключ клієнта gateway (runtime). Ключа провайдера runtime не має й не бачить. */
  apiKey: string;
  /** Псевдонім моделі з реєстру gateway: "haiku", "mock", "gpt-oss". */
  model: string;
  /** "concierge@1" — у журналі витрат gateway видно, який агент і яка версія палить гроші. */
  agentId: string;
  /** restricted → gateway пустить лише на локальні моделі. Береться зі специфікації агента. */
  dataClass: "internal" | "restricted";
  maxTokens?: number;
  fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

interface ChatResponse {
  model: string;
  choices: { message: AssistantMessage }[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * CallModel через LLM gateway (OpenAI-сумісний /v1/chat/completions, без стріму).
 * Стрім у CLI-чаті не потрібен для навчання циклу; gateway його вміє, додамо в studio.
 */
export function gatewayModel(opts: GatewayModelOptions): CallModel {
  const doFetch = opts.fetch ?? fetch;
  return async ({ messages, tools, runId }) => {
    const res = await doFetch(`${opts.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
        "x-run-id": runId,
        "x-agent-id": opts.agentId,
        "x-data-class": opts.dataClass,
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        // Порожній масив tools частина провайдерів відхиляє — не надсилаємо поле зовсім.
        ...(tools.length > 0 && { tools }),
        max_tokens: opts.maxTokens ?? 1024,
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      const code = body.error?.code ?? "unknown";
      const message = body.error?.message ?? res.statusText;
      // Бюджет — штатна зупинка: цикл поверне outcome budget_exceeded, а не впаде.
      if (res.status === 429 && code.endsWith("budget_exceeded")) throw new BudgetExceededError(code, message);
      throw new Error(`gateway ${res.status} ${code}: ${message}`);
    }

    const data = (await res.json()) as ChatResponse;
    const message = data.choices[0]?.message;
    if (!message) throw new Error("gateway: відповідь без choices");
    return {
      message,
      usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
      // Вартість рахує gateway (він знає ціни і кеш); runtime лише сумує.
      costUsd: Number(res.headers.get("x-gateway-cost-usd") ?? 0),
      model: data.model,
    };
  };
}
