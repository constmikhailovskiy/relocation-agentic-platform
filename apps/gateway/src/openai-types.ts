import { z } from "zod";

/**
 * Підмножина формату OpenAI Chat Completions — «мова», якою з gateway говорять клієнти
 * (runtime, evals). Gateway перекладає її в мову конкретного провайдера.
 *
 * Важливо: повідомлення описані через z.looseObject — НЕвідомі поля не відкидаються.
 * Наприклад, gpt-oss через Ollama повертає поле `reasoning`, і його треба віддати назад
 * у наступному виклику, інакше tool calling ламається. Суворий z.object тихо б його стер.
 */

export const ToolCall = z.looseObject({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type ToolCall = z.infer<typeof ToolCall>;

const TextPart = z.object({ type: z.literal("text"), text: z.string() });
const Content = z.union([z.string(), z.array(TextPart)]);

export const ChatMessage = z.discriminatedUnion("role", [
  z.looseObject({ role: z.literal("system"), content: Content }),
  z.looseObject({ role: z.literal("user"), content: Content }),
  z.looseObject({
    role: z.literal("assistant"),
    content: Content.nullable().optional(),
    tool_calls: z.array(ToolCall).optional(),
  }),
  z.looseObject({ role: z.literal("tool"), tool_call_id: z.string(), content: Content }),
]);
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ToolDef = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});
export type ToolDef = z.infer<typeof ToolDef>;

export const ChatRequest = z.looseObject({
  model: z.string(),
  messages: z.array(ChatMessage).min(1),
  tools: z.array(ToolDef).optional(),
  tool_choice: z
    .union([
      z.enum(["auto", "none", "required"]),
      z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  max_tokens: z.number().int().positive().max(32_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export type FinishReason = "stop" | "tool_calls" | "length";

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  [extra: string]: unknown;
}

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [{ index: 0; message: AssistantMessage; finish_reason: FinishReason }];
  usage: OpenAIUsage;
}

export interface ChunkToolCall {
  index: number;
  id?: string;
  type?: "function";
  function: { name?: string; arguments: string };
}

export interface ChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: { index: 0; delta: { role?: "assistant"; content?: string; reasoning?: string; tool_calls?: ChunkToolCall[] }; finish_reason: FinishReason | null }[];
  usage?: OpenAIUsage;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

/** Наш внутрішній облік токенів — детальніший за OpenAI-шний (окремо запис і читання кешу). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function toOpenAIUsage(u: Usage): OpenAIUsage {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.outputTokens,
    total_tokens: prompt + u.outputTokens,
    prompt_tokens_details: { cached_tokens: u.cacheReadTokens },
  };
}

/** Текст повідомлення незалежно від того, рядок це чи масив частин. */
export function textOf(content: z.infer<typeof Content> | null | undefined): string {
  if (content == null) return "";
  return typeof content === "string" ? content : content.map((p) => p.text).join("");
}
