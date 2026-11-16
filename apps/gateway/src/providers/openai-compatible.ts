import type { AssistantMessage, ChatRequest, FinishReason, Usage } from "../openai-types.ts";
import { HttpError } from "../reliability.ts";
import { parseSSE } from "../sse.ts";
import type { CompleteResult, Provider, StreamEvent } from "./types.ts";

/**
 * Провайдер для будь-якого OpenAI-сумісного API. У нас це Ollama (http://localhost:11434/v1).
 * Перекладати майже нічого не треба — але є пастка: ми НЕ відкидаємо невідомі поля
 * повідомлення. gpt-oss повертає `reasoning`, і клієнт має відправити його назад.
 */
interface OAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

const toUsage = (u: OAIUsage | undefined): Usage => ({
  inputTokens: (u?.prompt_tokens ?? 0) - (u?.prompt_tokens_details?.cached_tokens ?? 0),
  outputTokens: u?.completion_tokens ?? 0,
  cacheReadTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
  cacheWriteTokens: 0,
});

const normFinish = (f: string | null | undefined): FinishReason => (f === "tool_calls" ? "tool_calls" : f === "length" ? "length" : "stop");

export class OpenAICompatibleProvider implements Provider {
  constructor(
    readonly name: "ollama",
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      // Ollama не запущена → ECONNREFUSED. Для нас це «провайдер недоступний», тобто 503.
      throw new HttpError(503, `${this.name} недоступний: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new HttpError(res.status, `${this.name} ${res.status}: ${(await res.text()).slice(0, 300)}`, retryAfter ? retryAfter * 1000 : undefined);
    }
    return res;
  }

  async complete(req: ChatRequest, signal: AbortSignal): Promise<CompleteResult> {
    const res = await this.post({ ...req, stream: false }, signal);
    const json = (await res.json()) as { choices: { message: AssistantMessage; finish_reason: string }[]; usage?: OAIUsage };
    const choice = json.choices[0];
    if (!choice) throw new HttpError(502, `${this.name}: порожня відповідь`);
    return { message: choice.message, finishReason: normFinish(choice.finish_reason), usage: toUsage(json.usage) };
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await this.post({ ...req, stream: true, stream_options: { include_usage: true } }, signal);
    if (!res.body) throw new HttpError(502, `${this.name}: немає тіла відповіді`);
    let usage: Usage | undefined;
    for await (const ev of parseSSE(res.body)) {
      if (ev.data === "[DONE]") break;
      const chunk = JSON.parse(ev.data) as {
        choices?: { delta?: { content?: string | null; reasoning?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
        usage?: OAIUsage;
      };
      if (chunk.usage) usage = toUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      // gpt-oss стрімить міркування окремим полем. Без цього рядка вони тихо губляться.
      if (choice.delta?.reasoning) yield { type: "delta", delta: { reasoning: choice.delta.reasoning } };
      if (choice.delta?.content) yield { type: "delta", delta: { content: choice.delta.content } };
      for (const tc of choice.delta?.tool_calls ?? []) {
        yield {
          type: "delta",
          delta: { toolCall: { index: tc.index, ...(tc.id ? { id: tc.id } : {}), ...(tc.function?.name ? { name: tc.function.name } : {}), argumentsDelta: tc.function?.arguments ?? "" } },
        };
      }
      if (choice.finish_reason) yield { type: "finish", finishReason: normFinish(choice.finish_reason) };
    }
    yield { type: "usage", usage: usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}
