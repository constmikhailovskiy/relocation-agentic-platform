import type { CallModel, ModelReply } from "../src/model.ts";
import type { Message, ToolCall } from "../src/messages.ts";
import type { ToolHandle, ToolResult, ToolSet } from "../src/tools.ts";

/**
 * Сценарна модель для тестів: повертає наперед задані ходи по черзі.
 * Gateway-ний mock на таке не здатен (він робить один виклик на повідомлення користувача),
 * тому цикл перевіряємо з ін'єкцією CallModel, а gateway — окремим тонким тестом.
 */
export type Turn = string | { calls: [name: string, args: unknown][] } | ((messages: Message[]) => Turn);

export function scriptedModel(turns: Turn[], costUsd = 0.001): CallModel & { requests: Parameters<CallModel>[0][] } {
  const requests: Parameters<CallModel>[0][] = [];
  let i = 0;
  const fn = async (req: Parameters<CallModel>[0]): Promise<ModelReply> => {
    // Копія: цикл далі допише в історію, а нам треба знімок того, що модель бачила САМЕ ТОДІ.
    requests.push({ ...req, messages: structuredClone(req.messages) });
    const scripted = turns[i++];
    if (scripted === undefined) throw new Error(`Сценарій вичерпано на ході ${i}`);
    // Хід може залежати від того, що модель «побачила» (наприклад, ключ оголошення з результатів пошуку).
    const turn = typeof scripted === "function" ? scripted(req.messages) : scripted;
    if (typeof turn === "function") throw new Error("Хід-функція має повернути готовий хід");
    const usage = { inputTokens: 100, outputTokens: 10 };
    if (typeof turn === "string") return { message: { role: "assistant", content: turn }, usage, costUsd, model: "scripted" };
    const tool_calls: ToolCall[] = turn.calls.map(([name, args], k) => ({
      id: `call_${i}_${k}`,
      type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    }));
    return { message: { role: "assistant", content: null, tool_calls }, usage, costUsd, model: "scripted" };
  };
  return Object.assign(fn, { requests });
}

/** Фальшивий набір інструментів: записує виклики, відповідає заданою функцією. */
export function fakeTools(impl: Record<string, (args: unknown) => ToolResult>): ToolSet & { calls: { ref: string; args: unknown; meta: unknown }[] } {
  const calls: { ref: string; args: unknown; meta: unknown }[] = [];
  const handles = new Map<string, ToolHandle>(
    Object.entries(impl).map(([ref, run]) => {
      const modelName = ref.replace(".", "__");
      const handle: ToolHandle = {
        ref,
        modelName,
        def: { type: "function", function: { name: modelName, description: ref, parameters: { type: "object" } } },
        call: async (args, meta) => {
          calls.push({ ref, args, meta });
          return run(args);
        },
      };
      return [modelName, handle];
    }),
  );
  return { defs: [...handles.values()].map((h) => h.def), get: (name) => handles.get(name), close: async () => {}, calls };
}

export const ok = (data: unknown): ToolResult => ({ isError: false, text: JSON.stringify(data) });
export const err = (code: string, message = code): ToolResult => ({ isError: true, text: JSON.stringify({ error: { code, message, retryable: false } }) });
