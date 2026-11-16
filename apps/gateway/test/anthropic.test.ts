import { describe, expect, it } from "vitest";
import { fromAnthropicResponse, toAnthropicRequest, translateAnthropicStream } from "../src/providers/anthropic.ts";
import type { StreamEvent } from "../src/providers/types.ts";

const tools = [
  { type: "function" as const, function: { name: "search_listings", description: "Пошук", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "get_listing", parameters: { type: "object", properties: {} } } },
];

describe("OpenAI → Anthropic", () => {
  const req = toAnthropicRequest({
    model: "claude-haiku-5-5",
    tools,
    tool_choice: "required",
    messages: [
      { role: "system", content: "Ти помічник з релокації." },
      { role: "user", content: "Знайди двокімнатну" },
      { role: "assistant", content: null, tool_calls: [
        { id: "t1", type: "function", function: { name: "search_listings", arguments: '{"maxBudgetUah":18000}' } },
        { id: "t2", type: "function", function: { name: "get_listing", arguments: '{"key":"olx:1"}' } },
      ] },
      { role: "tool", tool_call_id: "t1", content: "[...]" },
      { role: "tool", tool_call_id: "t2", content: "{...}" },
    ],
  });

  it("system — окремим полем, з позначкою кешу", () => {
    expect(req.system?.[0]).toMatchObject({ text: "Ти помічник з релокації.", cache_control: { type: "ephemeral" } });
    expect(req.messages.every((m) => (m.role as string) !== "system")).toBe(true);
  });

  it("arguments-рядок стає input-об'єктом", () => {
    expect(req.messages[1]!.content[0]).toEqual({ type: "tool_use", id: "t1", name: "search_listings", input: { maxBudgetUah: 18000 } });
  });

  it("кілька tool-повідомлень зливаються в одне user-повідомлення (чергування ролей)", () => {
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(req.messages[2]!.content.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
  });

  it("tool_choice required → any, кеш на останньому інструменті, max_tokens за замовчуванням", () => {
    expect(req.tool_choice).toEqual({ type: "any" });
    expect(req.tools?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(req.tools?.[0]?.cache_control).toBeUndefined();
    expect(req.max_tokens).toBe(1024);
  });
});

describe("Anthropic → OpenAI", () => {
  it("tool_use стає tool_calls з arguments-рядком; usage з кешем", () => {
    const r = fromAnthropicResponse({
      content: [{ type: "text", text: "Шукаю…" }, { type: "tool_use", id: "tu_1", name: "search_listings", input: { minRooms: 2 } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.message.content).toBe("Шукаю…");
    expect(r.message.tool_calls?.[0]?.function).toEqual({ name: "search_listings", arguments: '{"minRooms":2}' });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0 });
  });
});

describe("Стрім Anthropic", () => {
  async function collect(events: { event: string; data: unknown }[]): Promise<StreamEvent[]> {
    async function* src() {
      for (const e of events) yield { event: e.event, data: JSON.stringify(e.data) };
    }
    const out: StreamEvent[] = [];
    for await (const ev of translateAnthropicStream(src())) out.push(ev);
    return out;
  }

  it("текст + інструмент: індекс інструмента рахується окремо від блоків тексту", async () => {
    const out = await collect([
      { event: "message_start", data: { message: { usage: { input_tokens: 50, cache_read_input_tokens: 1000 } } } },
      { event: "content_block_start", data: { index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "Дивлюсь" } } },
      { event: "content_block_stop", data: { index: 0 } },
      { event: "content_block_start", data: { index: 1, content_block: { type: "tool_use", id: "tu_9", name: "search_listings", input: {} } } },
      { event: "content_block_delta", data: { index: 1, delta: { type: "input_json_delta", partial_json: '{"minRo' } } },
      { event: "content_block_delta", data: { index: 1, delta: { type: "input_json_delta", partial_json: 'oms":2}' } } },
      { event: "ping", data: {} },
      { event: "message_delta", data: { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 31 } } },
      { event: "message_stop", data: {} },
    ]);
    expect(out).toEqual([
      { type: "delta", delta: { content: "Дивлюсь" } },
      { type: "delta", delta: { toolCall: { index: 0, id: "tu_9", name: "search_listings", argumentsDelta: "" } } },
      { type: "delta", delta: { toolCall: { index: 0, argumentsDelta: '{"minRo' } } },
      { type: "delta", delta: { toolCall: { index: 0, argumentsDelta: 'oms":2}' } } },
      { type: "finish", finishReason: "tool_calls" },
      { type: "usage", usage: { inputTokens: 50, outputTokens: 31, cacheReadTokens: 1000, cacheWriteTokens: 0 } },
    ]);
  });

  it("подія error посеред стріму стає винятком", async () => {
    await expect(collect([{ event: "error", data: { error: { type: "overloaded_error", message: "Overloaded" } } }])).rejects.toThrow(/Overloaded/);
  });
});
