import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import type { StreamEvent } from "../src/providers/types.ts";

/**
 * Вправа 5 без Ollama: підміняємо глобальний fetch і дивимось, що провайдер
 * НАДСИЛАЄ в Ollama і як РОЗБИРАЄ її відповідь. Мережі немає — тест працює і в потязі.
 *
 * Назва поля `reasoning` — припущення з документації Ollama для gpt-oss.
 * Коли Ollama буде встановлена, звіримо з живою відповіддю (крок 3 вправи 5).
 */

/** Підмінений fetch: запам'ятовує тіло запиту і повертає заготовлену відповідь. */
function stubFetch(response: Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return response;
  });
  return calls;
}

/** Збирає SSE-потік з окремих JSON-чанків — так, як його віддає Ollama. */
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");

const provider = new OpenAICompatibleProvider("ollama", "http://localhost:11434");
const signal = new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe("Ollama: звичайна відповідь (complete)", () => {
  it("поле reasoning з відповіді моделі не губиться", async () => {
    stubFetch(Response.json({
      choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: "", reasoning: "Треба шукати двокімнатні до 18 000 грн",
        tool_calls: [{ id: "c1", type: "function", function: { name: "search_listings", arguments: "{}" } }],
      } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    }));

    const res = await provider.complete({ model: "gpt-oss:20b", messages: [{ role: "user", content: "Знайди квартиру" }] }, signal);

    expect(res.message).toMatchObject({ reasoning: "Треба шукати двокімнатні до 18 000 грн" });
    expect(res.finishReason).toBe("tool_calls");
  });

  it("reasoning з історії доходить до Ollama в наступному запиті", async () => {
    const calls = stubFetch(Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Готово" } }] }));

    await provider.complete({
      model: "gpt-oss:20b",
      messages: [
        { role: "user", content: "Знайди квартиру" },
        { role: "assistant", content: null, reasoning: "Спершу пошук", tool_calls: [{ id: "c1", type: "function", function: { name: "search_listings", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "[]" },
      ],
    }, signal);

    expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0]?.body.messages).toContainEqual(expect.objectContaining({ role: "assistant", reasoning: "Спершу пошук" }));
  });
});

describe("Ollama: стрім", () => {
  it("шматки reasoning у стрімі не губляться", async () => {
    stubFetch(sse([
      { choices: [{ delta: { role: "assistant", reasoning: "Думаю" } }] },
      { choices: [{ delta: { reasoning: " про бюджет" } }] },
      { choices: [{ delta: { content: "Ось варіанти" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]));

    const events: StreamEvent[] = [];
    for await (const ev of provider.stream({ model: "gpt-oss:20b", messages: [{ role: "user", content: "Привіт" }] }, signal)) events.push(ev);

    expect(events).toContainEqual({ type: "delta", delta: { content: "Ось варіанти" } });
    expect(events).toContainEqual({ type: "delta", delta: { reasoning: "Думаю" } });
    expect(events).toContainEqual({ type: "delta", delta: { reasoning: " про бюджет" } });
  });
});
