import type { AssistantMessage, ChatMessage, ChatRequest, FinishReason, ToolCall, Usage } from "../openai-types.ts";
import { textOf } from "../openai-types.ts";
import { HttpError } from "../reliability.ts";
import { parseSSE } from "../sse.ts";
import type { CompleteResult, Provider, StreamEvent } from "./types.ts";

/**
 * Адаптер Anthropic Messages API. Тут живе вся «пастка уніфікованого API»:
 * формати схожі, але не однакові, і кожна відмінність — потенційний баг.
 *
 *  OpenAI                               Anthropic
 *  ---------------------------------    -----------------------------------------------
 *  system-повідомлення в messages       окреме поле `system`
 *  assistant.tool_calls[].arguments     content-блок tool_use з `input` — ОБ'ЄКТ, не рядок
 *  повідомлення role:"tool"             user-повідомлення з блоком tool_result
 *  tools[].function.parameters          tools[].input_schema
 *  tool_choice "required"               { type: "any" }
 *  max_tokens необов'язковий            max_tokens ОБОВ'ЯЗКОВИЙ
 *  stop_reason у різних назвах          end_turn / tool_use / max_tokens
 */

type ABlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AMessage {
  role: "user" | "assistant";
  content: ABlock[];
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: ABlock[];
  messages: AMessage[];
  tools?: { name: string; description?: string; input_schema: unknown; cache_control?: { type: "ephemeral" } }[];
  tool_choice?: { type: "auto" | "any" | "none" } | { type: "tool"; name: string };
  temperature?: number;
  stream?: boolean;
}

const DEFAULT_MAX_TOKENS = 1024;

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    // Модель (або клієнт) прислала битий JSON. Не падаємо — передаємо як є, хай модель побачить.
    return { _raw: raw };
  }
}

export function toAnthropicRequest(req: ChatRequest): AnthropicRequest {
  const system = req.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
  const out: AMessage[] = [];

  // Anthropic вимагає чергування user/assistant, тому сусідні повідомлення однієї ролі зливаємо.
  const push = (role: AMessage["role"], blocks: ABlock[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of req.messages as ChatMessage[]) {
    if (m.role === "system") continue;
    if (m.role === "user") push("user", [{ type: "text", text: textOf(m.content) }]);
    if (m.role === "tool") {
      const text = textOf(m.content);
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: text, ...(m["is_error"] === true ? { is_error: true } : {}) }]);
    }
    if (m.role === "assistant") {
      const blocks: ABlock[] = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.tool_calls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      push("assistant", blocks);
    }
  }

  const tools = req.tools?.map((t) => ({
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    input_schema: t.function.parameters,
  }));

  /**
   * Prompt caching: системний промпт і опис інструментів однакові на кожному кроці агента.
   * Позначаємо кінець стабільного префікса — повторні кроки читатимуть його з кешу
   * (для Haiku 5.5 це $0.01 замість $0.10 за мільйон). Короткі префікси провайдер просто не кешує.
   */
  const lastTool = tools?.at(-1);
  if (lastTool) Object.assign(lastTool, { cache_control: { type: "ephemeral" as const } });

  let tool_choice: AnthropicRequest["tool_choice"];
  const tc = req.tool_choice;
  if (tc === "auto") tool_choice = { type: "auto" };
  else if (tc === "none") tool_choice = { type: "none" };
  else if (tc === "required") tool_choice = { type: "any" };
  else if (tc && typeof tc === "object") tool_choice = { type: "tool", name: tc.function.name };

  return {
    model: req.model,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
    ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
    messages: out,
    ...(tools?.length ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

interface AUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

const toUsage = (u: AUsage | undefined): Usage => ({
  inputTokens: u?.input_tokens ?? 0,
  outputTokens: u?.output_tokens ?? 0,
  cacheReadTokens: u?.cache_read_input_tokens ?? 0,
  cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
});

const finishFrom = (stop: string | null | undefined): FinishReason => (stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : "stop");

export function fromAnthropicResponse(json: { content: ABlock[]; stop_reason: string | null; usage: AUsage }): CompleteResult {
  const text = json.content.filter((b): b is Extract<ABlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
  const toolCalls: ToolCall[] = json.content
    .filter((b): b is Extract<ABlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const message: AssistantMessage = { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  return { message, finishReason: finishFrom(json.stop_reason), usage: toUsage(json.usage) };
}

/**
 * Переклад стріму Anthropic у наші події. Події Anthropic:
 *   message_start (usage входу) → content_block_start → content_block_delta* → content_block_stop
 *   → … → message_delta (stop_reason, usage виходу) → message_stop
 * Індекс блоку в Anthropic рахує і текстові, і tool_use блоки, а в OpenAI tool_calls[].index —
 * лише інструменти. Тому ведемо окрему мапу «індекс блоку → індекс інструмента».
 */
export async function* translateAnthropicStream(events: AsyncIterable<{ event: string; data: string }>): AsyncGenerator<StreamEvent> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const toolIndexByBlock = new Map<number, number>();
  for await (const { event, data } of events) {
    const ev = JSON.parse(data) as Record<string, any>;
    switch (event) {
      case "message_start":
        Object.assign(usage, toUsage(ev.message?.usage));
        break;
      case "content_block_start":
        if (ev.content_block?.type === "tool_use") {
          const toolIndex = toolIndexByBlock.size;
          toolIndexByBlock.set(ev.index, toolIndex);
          yield { type: "delta", delta: { toolCall: { index: toolIndex, id: ev.content_block.id, name: ev.content_block.name, argumentsDelta: "" } } };
        }
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta") yield { type: "delta", delta: { content: ev.delta.text } };
        if (ev.delta?.type === "input_json_delta") {
          const index = toolIndexByBlock.get(ev.index) ?? 0;
          yield { type: "delta", delta: { toolCall: { index, argumentsDelta: ev.delta.partial_json } } };
        }
        break;
      case "message_delta":
        if (ev.usage?.output_tokens !== undefined) usage.outputTokens = ev.usage.output_tokens;
        if (ev.delta?.stop_reason) yield { type: "finish", finishReason: finishFrom(ev.delta.stop_reason) };
        break;
      case "error":
        throw new HttpError(ev.error?.type === "overloaded_error" ? 529 : 502, `anthropic stream error: ${ev.error?.message ?? data}`);
      default: // ping, content_block_stop, message_stop
        break;
    }
  }
  yield { type: "usage", usage };
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {}

  private async post(body: AnthropicRequest, signal: AbortSignal): Promise<Response> {
    if (!this.apiKey) throw new HttpError(503, "ANTHROPIC_API_KEY не задано");
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new HttpError(503, `anthropic недоступний: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new HttpError(res.status, `anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`, retryAfter ? retryAfter * 1000 : undefined);
    }
    return res;
  }

  async complete(req: ChatRequest, signal: AbortSignal): Promise<CompleteResult> {
    const res = await this.post(toAnthropicRequest(req), signal);
    return fromAnthropicResponse((await res.json()) as Parameters<typeof fromAnthropicResponse>[0]);
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await this.post({ ...toAnthropicRequest(req), stream: true }, signal);
    if (!res.body) throw new HttpError(502, "anthropic: немає тіла відповіді");
    yield* translateAnthropicStream(parseSSE(res.body));
  }
}
