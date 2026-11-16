import type { AssistantMessage, ChatRequest, Usage } from "../openai-types.ts";
import { textOf } from "../openai-types.ts";
import type { CompleteResult, Provider, StreamEvent } from "./types.ts";

/**
 * Детермінована «модель» для тестів і роботи без ключів.
 *  - Якщо останнє повідомлення — результат інструмента: відповідає текстом про нього.
 *  - Якщо в тексті користувача є `[call:tool_name {"json":"args"}]` і передано tools: робить tool call.
 *  - Інакше: повертає «mock: <текст користувача>». Так тести бачать, що саме дійшло до моделі
 *    (наприклад, що телефон був відредагований).
 */
const CALL = /\[call:([a-z_][a-z0-9_.]*)\s*(\{.*\})?\]/i;

function decide(req: ChatRequest): { message: AssistantMessage; finish: "stop" | "tool_calls" } {
  const last = req.messages.at(-1)!;
  if (last.role === "tool") {
    return { message: { role: "assistant", content: `Отримав результат інструмента: ${textOf(last.content).slice(0, 80)}` }, finish: "stop" };
  }
  const text = textOf(last.content);
  const m = CALL.exec(text);
  if (m && req.tools?.some((t) => t.function.name === m[1])) {
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `call_mock_${m[1]}`, type: "function", function: { name: m[1]!, arguments: m[2] ?? "{}" } }],
      },
      finish: "tool_calls",
    };
  }
  return { message: { role: "assistant", content: `mock: ${text}` }, finish: "stop" };
}

function usageFor(req: ChatRequest, reply: AssistantMessage): Usage {
  const inChars = req.messages.reduce((n, m) => n + textOf(m.content).length, 0) + JSON.stringify(req.tools ?? []).length;
  const outChars = (reply.content ?? "").length + JSON.stringify(reply.tool_calls ?? []).length;
  return { inputTokens: Math.ceil(inChars / 3), outputTokens: Math.ceil(outChars / 3), cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export class MockProvider implements Provider {
  readonly name = "mock" as const;

  async complete(req: ChatRequest): Promise<CompleteResult> {
    const { message, finish } = decide(req);
    return { message, finishReason: finish, usage: usageFor(req, message) };
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const { message, finish } = decide(req);
    if (message.tool_calls) {
      const tc = message.tool_calls[0]!;
      yield { type: "delta", delta: { toolCall: { index: 0, id: tc.id, name: tc.function.name, argumentsDelta: "" } } };
      yield { type: "delta", delta: { toolCall: { index: 0, argumentsDelta: tc.function.arguments } } };
    } else {
      const text = message.content ?? "";
      const step = Math.max(1, Math.ceil(text.length / 3));
      for (let i = 0; i < text.length; i += step) {
        signal.throwIfAborted();
        yield { type: "delta", delta: { content: text.slice(i, i + step) } };
      }
    }
    yield { type: "finish", finishReason: finish };
    yield { type: "usage", usage: usageFor(req, message) };
  }
}
