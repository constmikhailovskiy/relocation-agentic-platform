import { describe, expect, it } from "vitest";
import { createApp } from "../../gateway/src/app.ts";
import { sha256 } from "../../gateway/src/config.ts";
import { Ledger } from "../../gateway/src/ledger.ts";
import { MockProvider } from "../../gateway/src/providers/mock.ts";
import type { Provider } from "../../gateway/src/providers/types.ts";
import { DEFAULT_REGISTRY, Registry } from "../../gateway/src/registry.ts";
import { gatewayModel } from "../src/gateway-model.ts";
import { BudgetExceededError } from "../src/model.ts";

/**
 * Тонкий тест «проводки» runtime → gateway: справжній gateway з mock-провайдером, без мережі.
 * Mock робить ОДИН виклик інструмента за маркером `[call:name {...}]` — для сценаріїв він не годиться,
 * тому цикл перевіряється сценарною моделлю (loop.test.ts), а тут лише HTTP-контракт.
 */
function setup(maxRunUsd = 1, apiKey = "k") {
  const ledger = new Ledger(":memory:");
  const mock = new MockProvider();
  const app = createApp({
    config: {
      GATEWAY_CLIENTS: [{ name: "runtime", keySha256: sha256("k"), models: ["mock"], dailyBudgetUsd: 5, maxRunUsd }],
      ALLOWED_MODEL_ORIGINS: ["UA"],
      FAIL_PROVIDER: undefined,
      UPSTREAM_TIMEOUT_MS: 5_000,
    },
    registry: new Registry(DEFAULT_REGISTRY),
    providers: { mock, ollama: mock as unknown as Provider, anthropic: mock as unknown as Provider },
    ledger,
    retry: { retries: 0, baseMs: 1 },
  });
  const seen: Headers[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return app.request(url, init);
  };
  const model = gatewayModel({ baseUrl: "http://gateway.test", apiKey, model: "mock", agentId: "concierge@1", dataClass: "internal", fetch });
  return { model, seen, bodies, ledger };
}

const TOOL = { type: "function" as const, function: { name: "relocation__get_search", parameters: { type: "object" } } };

describe("gatewayModel", () => {
  it("tool call від моделі приходить у форматі OpenAI; usage і вартість — з відповіді gateway", async () => {
    const { model } = setup();
    const r = await model({ messages: [{ role: "user", content: '[call:relocation__get_search {"employee_id":"olena"}]' }], tools: [TOOL], runId: "run-1" });
    expect(r.message.tool_calls).toEqual([
      { id: expect.any(String), type: "function", function: { name: "relocation__get_search", arguments: '{"employee_id":"olena"}' } },
    ]);
    expect(r.model).toBe("mock");
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("заголовки: ключ клієнта, x-run-id, x-agent-id, x-data-class", async () => {
    const { model, seen, ledger } = setup();
    await model({ messages: [{ role: "user", content: "hi" }], tools: [], runId: "run-42" });
    expect(seen[0]!.get("authorization")).toBe("Bearer k");
    expect(seen[0]!.get("x-run-id")).toBe("run-42");
    expect(seen[0]!.get("x-agent-id")).toBe("concierge@1");
    expect(seen[0]!.get("x-data-class")).toBe("internal");
    // gateway записав витрати саме на цей запуск
    expect(ledger.runSummary("runtime", "run-42").calls).toBe(1);
  });

  it("без інструментів поле tools не надсилається (деякі провайдери не люблять порожній масив)", async () => {
    const { model, bodies } = setup();
    await model({ messages: [{ role: "user", content: "hi" }], tools: [], runId: "r" });
    await model({ messages: [{ role: "user", content: "hi" }], tools: [TOOL], runId: "r" });
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(bodies[1]!.tools).toEqual([TOOL]);
  });

  it("429 run_budget_exceeded → BudgetExceededError (цикл зупиниться штатно)", async () => {
    const { model } = setup(0.000001);
    await expect(model({ messages: [{ role: "user", content: "hi" }], tools: [], runId: "r" })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("інша помилка gateway (тут 401, чужий ключ) → Error з кодом і статусом, не BudgetExceededError", async () => {
    const { model } = setup(1, "wrong");
    const e = await model({ messages: [{ role: "user", content: "hi" }], tools: [], runId: "r" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(BudgetExceededError);
    expect(String(e)).toMatch(/401/);
  });
});
