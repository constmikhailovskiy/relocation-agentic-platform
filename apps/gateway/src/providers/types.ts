import type { AssistantMessage, ChatRequest, FinishReason, Usage } from "../openai-types.ts";
import type { ProviderName } from "../registry.ts";

/**
 * Контракт провайдера. Усередині gateway усе говорить «OpenAI-форматом»,
 * а кожен провайдер перекладає його у свій API і назад.
 *
 * Стрім віддає не готові SSE-чанки, а прості події: шматок відповіді або фінальний usage.
 * HTTP-шар сам загортає їх у формат OpenAI — провайдери про HTTP клієнта нічого не знають.
 */
export type StreamDelta = {
  content?: string;
  reasoning?: string;
  toolCall?: { index: number; id?: string; name?: string; argumentsDelta: string };
};

export type StreamEvent =
  | { type: "delta"; delta: StreamDelta }
  | { type: "finish"; finishReason: FinishReason }
  | { type: "usage"; usage: Usage };

export interface CompleteResult {
  message: AssistantMessage;
  finishReason: FinishReason;
  usage: Usage;
}

export interface Provider {
  readonly name: ProviderName;
  complete(req: ChatRequest, signal: AbortSignal): Promise<CompleteResult>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent>;
}
