import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { sha256 } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { MockProvider } from "../src/providers/mock.ts";
import type { Provider } from "../src/providers/types.ts";
import { DEFAULT_REGISTRY, type ModelEntry, Registry } from "../src/registry.ts";
import { HttpError } from "../src/reliability.ts";

/**
 * Інтеграційні тести gateway без мережі: замість Anthropic і Ollama — підставні провайдери.
 * app.request() викликає Hono-застосунок напряму, без реального HTTP-сервера.
 */

const mockEntry = DEFAULT_REGISTRY.find((m) => m.alias === "mock")!;
const extra: ModelEntry[] = [
  // «Хмарна» mock-модель: на ній перевіряємо, що PII редагується перед відправкою назовні.
  { ...mockEntry, alias: "mock-cloud", local: false, fallback: undefined } as ModelEntry,
  { ...mockEntry, alias: "cn-model", origin: "CN", fallback: undefined } as ModelEntry,
  { ...mockEntry, alias: "flaky", provider: "anthropic", fallback: "mock-backup" } as ModelEntry,
];

function setup(opts: { failProvider?: string; anthropic?: Provider; dailyBudgetUsd?: number; maxRunUsd?: number } = {}) {
  const ledger = new Ledger(":memory:");
  const failing: Provider = {
    name: "anthropic",
    async complete() { throw new HttpError(503, "overloaded"); },
    // eslint-disable-next-line require-yield
    async *stream() { throw new HttpError(503, "overloaded"); },
  };
  const app = createApp({
    config: {
      GATEWAY_CLIENTS: [{
        name: "runtime",
        keySha256: sha256("k"),
        models: ["mock", "mock-backup", "mock-cloud", "cn-model", "flaky"],
        dailyBudgetUsd: opts.dailyBudgetUsd ?? 5,
        maxRunUsd: opts.maxRunUsd ?? 1,
      }, {
        name: "evals",
        keySha256: sha256("k2"),
        models: ["mock"],
        dailyBudgetUsd: 5,
        maxRunUsd: 1,
      }],
      ALLOWED_MODEL_ORIGINS: ["US", "FR", "UA"],
      FAIL_PROVIDER: opts.failProvider,
      UPSTREAM_TIMEOUT_MS: 5_000,
    },
    registry: new Registry([...DEFAULT_REGISTRY, ...extra]),
    providers: { mock: new MockProvider(), ollama: new MockProvider() as unknown as Provider, anthropic: opts.anthropic ?? failing },
    ledger,
    retry: { retries: 1, baseMs: 1 },
  });
  const get = (path: string, key = "k") => app.request(path, { headers: { authorization: `Bearer ${key}` } });
  const call = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { app, ledger, call, get };
}

const ask = (model: string, content: string, extraBody: object = {}) => ({ model, messages: [{ role: "user", content }], ...extraBody });

describe("Gateway: базовий шлях", () => {
  it("без ключа — 401", async () => {
    const { app } = setup();
    const res = await app.request("/v1/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("невалідне тіло — 400 з поясненням", async () => {
    const { call } = setup();
    const res = await call({ model: "mock" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/messages/);
  });

  it("відповідає у форматі OpenAI і записує витрати", async () => {
    const { call, ledger } = setup();
    const res = await call(ask("mock", "Привіт"), { "x-run-id": "run-1" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model: string; choices: { message: { content: string } }[] };
    expect(json.model).toBe("mock");
    expect(json.choices[0]!.message.content).toBe("mock: Привіт");
    expect(res.headers.get("x-gateway-cost-usd")).toBeTruthy();
    expect(ledger.spentOnRunUsd("runtime", "run-1")).toBeGreaterThan(0);
  });

  it("tool calling проходить крізь gateway", async () => {
    const { call } = setup();
    const tools = [{ type: "function", function: { name: "search_listings", parameters: { type: "object" } } }];
    const res = await call(ask("mock", 'Шукай [call:search_listings {"minRooms":2}]', { tools }));
    const json = (await res.json()) as { choices: { finish_reason: string; message: { tool_calls: { function: { arguments: string } }[] } }[] };
    expect(json.choices[0]!.finish_reason).toBe("tool_calls");
    expect(json.choices[0]!.message.tool_calls[0]!.function.arguments).toBe('{"minRooms":2}');
  });
});

describe("Gateway: політики", () => {
  it("модель із забороненим походженням — 403", async () => {
    const { call } = setup();
    const res = await call(ask("cn-model", "test"));
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/origin_not_allowed/);
  });

  it("телефон не доходить до хмарної моделі, але доходить до локальної", async () => {
    const { call } = setup();
    const cloud = (await (await call(ask("mock-cloud", "Мій номер +380 67 123 45 67"))).json()) as { choices: { message: { content: string } }[] };
    expect(cloud.choices[0]!.message.content).toBe("mock: Мій номер [PHONE]");
    const local = (await (await call(ask("mock", "Мій номер +380 67 123 45 67"))).json()) as { choices: { message: { content: string } }[] };
    expect(local.choices[0]!.message.content).toContain("+380 67 123 45 67");
  });

  it("restricted-дані в хмарну модель — 403", async () => {
    const { call } = setup();
    const res = await call(ask("mock-cloud", "секрет"), { "x-data-class": "restricted" });
    expect(res.status).toBe(403);
  });

  // mock коштує $1/$2 за мільйон токенів і «відповідає» луною, тож довгий текст = реальні витрати.
  // ~6000 символів ≈ 2000 токенів входу + 2000 виходу ≈ $0.006 фактично; оцінка до виклику ≈ $0.004.
  const long = "квартира ".repeat(670);

  it("денний бюджет вичерпано — 429", async () => {
    const { call } = setup({ dailyBudgetUsd: 0.005 });
    expect((await call(ask("mock", long))).status).toBe(200);
    const res = await call(ask("mock", "два"));
    expect(res.status).toBe(429);
    expect(await res.text()).toMatch(/daily_budget_exceeded/);
  });

  it("бюджет запуску рахується за x-run-id", async () => {
    const { call } = setup({ maxRunUsd: 0.005 });
    expect((await call(ask("mock", long), { "x-run-id": "r" })).status).toBe(200);
    expect((await call(ask("mock", "два"), { "x-run-id": "r" })).status).toBe(429);
    expect((await call(ask("mock", "інший запуск"), { "x-run-id": "r2" })).status).toBe(200);
  });
});

describe("Gateway: надійність", () => {
  it("FAIL_PROVIDER → fallback на резервну модель, із заголовком", async () => {
    // Вимикаємо саме аліас "flaky": його fallback mock-backup живий.
    const { call: callAlias } = setup({ failProvider: "flaky" });
    const res = await callAlias(ask("flaky", "привіт"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-model")).toBe("mock-backup");
    expect(res.headers.get("x-gateway-fallback-from")).toBe("flaky");
  });

  it("провайдер віддає 503 → ретрай, потім fallback", async () => {
    const { call, ledger } = setup();
    const res = await call(ask("flaky", "привіт"), { "x-run-id": "fb" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-model")).toBe("mock-backup");
    expect(ledger.recent("runtime", 1)).toMatchObject([{ model_alias: "mock-backup", fallback_from: "flaky" }]);
  });

  it("помилка 400 від провайдера НЕ веде до fallback", async () => {
    const bad: Provider = {
      name: "anthropic",
      async complete() { throw new HttpError(400, "invalid tool schema"); },
      // eslint-disable-next-line require-yield
      async *stream() { throw new HttpError(400, "invalid tool schema"); },
    };
    const { call } = setup({ anthropic: bad });
    const res = await call(ask("flaky", "привіт"));
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/invalid tool schema/);
  });

  it("після серії збоїв circuit breaker розмикається", async () => {
    const { app, call } = setup();
    // Breaker рахує невдалі ЗАПИТИ (після всіх ретраїв), поріг — 5.
    for (let i = 0; i < 5; i++) await call(ask("flaky", "x"));
    const health = (await (await app.request("/healthz")).json()) as { breakers: Record<string, string> };
    expect(health.breakers["anthropic"]).toBe("open");
  });
});

describe("Gateway: стрімінг", () => {
  async function sseData(res: Response): Promise<string[]> {
    const text = await res.text();
    return text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  }

  it("текст приходить чанками у форматі OpenAI, з usage і [DONE]", async () => {
    const { call, ledger } = setup();
    const res = await call(ask("mock", "Привіт, світе", { stream: true, stream_options: { include_usage: true } }), { "x-run-id": "s1" });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const data = await sseData(res);
    expect(data.at(-1)).toBe("[DONE]");
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d));
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toBe("mock: Привіт, світе");
    expect(chunks.at(-1).usage.completion_tokens).toBeGreaterThan(0);
    expect(ledger.spentOnRunUsd("runtime", "s1")).toBeGreaterThan(0);
  });

  it("стрім із fallback до першого байта", async () => {
    const { call } = setup();
    const res = await call(ask("flaky", "привіт", { stream: true }));
    expect(res.headers.get("x-gateway-model")).toBe("mock-backup");
    expect((await sseData(res)).at(-1)).toBe("[DONE]");
  });

  it("tool call у стрімі: id і name в першому чанку, аргументи — далі", async () => {
    const { call } = setup();
    const tools = [{ type: "function", function: { name: "get_listing", parameters: { type: "object" } } }];
    const data = await sseData(await call(ask("mock", '[call:get_listing {"key":"olx:1"}]', { tools, stream: true })));
    const deltas = data.slice(0, -1).map((d) => JSON.parse(d).choices[0]?.delta?.tool_calls?.[0]).filter(Boolean);
    expect(deltas[0]).toMatchObject({ index: 0, id: "call_mock_get_listing", function: { name: "get_listing" } });
    expect(deltas.map((d: { function: { arguments: string } }) => d.function.arguments).join("")).toBe('{"key":"olx:1"}');
  });

  it("Вправа 5: reasoning зі стріму провайдера доходить до клієнта", async () => {
    // Провайдер, який стрімить як gpt-oss: спершу міркування, потім текст.
    const thinking: Provider = {
      name: "anthropic",
      async complete() { throw new Error("не викликається"); },
      async *stream() {
        yield { type: "delta", delta: { reasoning: "Думаю про бюджет" } };
        yield { type: "delta", delta: { content: "Ось варіанти" } };
        yield { type: "finish", finishReason: "stop" };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    };
    const { call } = setup({ anthropic: thinking });
    const data = await sseData(await call(ask("flaky", "привіт", { stream: true })));
    const deltas = data.slice(0, -1).map((d) => JSON.parse(d).choices[0]?.delta);
    expect(deltas).toContainEqual({ reasoning: "Думаю про бюджет" });
    expect(deltas).toContainEqual({ content: "Ось варіанти" });
  });
});

describe("Вправа 2: витрати по запуску", () => {
  it("клієнт бачить витрати свого запуску", async () => {
    const { call, get } = setup();
    await call(ask("mock", "раз"), { "x-run-id": "run-a" });
    await call(ask("mock", "два"), { "x-run-id": "run-a" });
    const res = await get("/v1/usage/runs/run-a");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { calls: number; spentUsd: number; models: string[] };
    expect(json.calls).toBe(2);
    expect(json.spentUsd).toBeGreaterThan(0);
    expect(json.models).toEqual(["mock"]);
  });

  it("чужий запуск — 404, так само як неіснуючий", async () => {
    const { call, get } = setup();
    await call(ask("mock", "раз"), { "x-run-id": "run-a" });
    const foreign = await get("/v1/usage/runs/run-a", "k2");
    const missing = await get("/v1/usage/runs/nope");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("однаковий run_id у різних клієнтів не ділить бюджет", async () => {
    const { call, ledger } = setup();
    await call(ask("mock", "раз"), { "x-run-id": "shared" });
    expect(ledger.spentOnRunUsd("runtime", "shared")).toBeGreaterThan(0);
    expect(ledger.spentOnRunUsd("evals", "shared")).toBe(0);
  });
});

describe("Вправа 4: хаос", () => {
  it("якщо впали всі кандидати, помилка перелічує кожну спробу", async () => {
    // flaky → mock-backup; вимикаємо обидва через провайдери: anthropic падає сам, mock — через FAIL_PROVIDER
    const { call } = setup({ failProvider: "mock" });
    const res = await call(ask("flaky", "привіт"));
    expect(res.status).toBe(502);
    const msg = ((await res.json()) as { error: { message: string } }).error.message;
    expect(msg).toMatch(/flaky: overloaded/);
    expect(msg).toMatch(/mock-backup: chaos/);
  });
});
