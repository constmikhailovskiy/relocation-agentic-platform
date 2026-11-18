import { describe, expect, it } from "vitest";
import type { Guard, TraceEvent } from "../src/loop.ts";
import { runTurn } from "../src/loop.ts";
import type { Message } from "../src/messages.ts";
import { BudgetExceededError } from "../src/model.ts";
import { err, fakeTools, ok, scriptedModel } from "./fakes.ts";

/**
 * Цикл агента без мережі: модель — сценарій, інструменти — фальшиві.
 * Перевіряємо саме цикл: що йде моделі, що виконується, коли зупиняємось.
 */
const LIMITS = { maxSteps: 5, maxCostUsdPerRun: 0.2 };

function setup(turns: Parameters<typeof scriptedModel>[0], tools = fakeTools({ "relocation.get_search": () => ok({ id: "s-olena" }) })) {
  const model = scriptedModel(turns);
  const trace: TraceEvent[] = [];
  const history: Message[] = [{ role: "system", content: "sys" }];
  const run = (input: string, extra: { guards?: Map<string, Guard>; costUsd?: number } = {}) =>
    runTurn(history, input, { model, tools, limits: LIMITS, runId: "run-1", onTrace: (e) => trace.push(e), ...(extra.guards && { guards: extra.guards }) });
  return { model, tools, trace, history, run };
}

describe("runTurn: основний цикл", () => {
  it("модель одразу відповідає текстом → answer, один крок, інструментів немає", async () => {
    const { run, tools } = setup(["Привіт!"]);
    expect(await run("hi")).toEqual({ kind: "answer", text: "Привіт!", steps: 1, costUsd: 0.001 });
    expect(tools.calls).toEqual([]);
  });

  it("виклик інструмента → результат повертається моделі як tool-повідомлення з тим самим id", async () => {
    const { run, model, tools } = setup([{ calls: [["relocation__get_search", { employee_id: "olena" }]] }, "Твій пошук: s-olena"]);
    const out = await run("що з моїм пошуком?");
    expect(out).toMatchObject({ kind: "answer", text: "Твій пошук: s-olena", steps: 2 });
    expect(tools.calls).toMatchObject([{ ref: "relocation.get_search", args: { employee_id: "olena" } }]);
    const second = model.requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1_0" }] });
    expect(second.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1_0", content: JSON.stringify({ id: "s-olena" }) });
  });

  it("моделі передаються визначення інструментів з набору", async () => {
    const { run, model } = setup(["ok"]);
    await run("hi");
    expect(model.requests[0]!.tools.map((t) => t.function.name)).toEqual(["relocation__get_search"]);
  });

  it("історія живе між ходами чату: другий хід бачить перший", async () => {
    const { run, model } = setup(["перша відповідь", "друга"]);
    await run("раз");
    await run("два");
    expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("кожен виклик отримує _meta.idempotencyKey = runId:step:index — його генерує runtime, а не модель", async () => {
    const { run, tools } = setup([
      { calls: [["relocation__get_search", {}], ["relocation__get_search", {}]] },
      { calls: [["relocation__get_search", {}]] },
      "done",
    ]);
    await run("x");
    expect(tools.calls.map((c) => c.meta)).toEqual([
      { idempotencyKey: "run-1:1:0" },
      { idempotencyKey: "run-1:1:1" },
      { idempotencyKey: "run-1:2:0" },
    ]);
  });
});

describe("runTurn: помилки повертаються моделі, а не валять запуск", () => {
  it("невідомий інструмент (зокрема поза allowlist) → tool-повідомлення з unknown_tool; нічого не виконано", async () => {
    const { run, model, tools } = setup([{ calls: [["relocation__decide_budget", {}]] }, "вибач"]);
    expect(await run("x")).toMatchObject({ kind: "answer" });
    expect(tools.calls).toEqual([]);
    const reply = model.requests[1]!.messages.at(-1)!;
    expect(reply).toMatchObject({ role: "tool", tool_call_id: "call_1_0" });
    expect(JSON.parse(reply.content as string)).toMatchObject({ error: { code: "unknown_tool" } });
    expect(reply.content).toContain("relocation__get_search"); // підказка: що є
  });

  it("невалідний JSON в аргументах → invalid_arguments; інструмент не викликано", async () => {
    const { run, model, tools } = setup([{ calls: [["relocation__get_search", "{employee_id: olena"]] }, "ok"]);
    await run("x");
    expect(tools.calls).toEqual([]);
    expect(JSON.parse(model.requests[1]!.messages.at(-1)!.content as string)).toMatchObject({ error: { code: "invalid_arguments" } });
  });

  it("помилка інструмента (isError) іде моделі як є, з кодом у трейсі", async () => {
    const tools = fakeTools({ "relocation.get_search": () => err("not_found", "Пошук не знайдено") });
    const { run, model, trace } = setup([{ calls: [["relocation__get_search", {}]] }, "не знайшов"], tools);
    await run("x");
    expect(model.requests[1]!.messages.at(-1)!.content).toContain("not_found");
    expect(trace.find((e) => e.type === "tool")).toMatchObject({ tool: "relocation.get_search", ok: false, error: "not_found" });
  });

  it("виклик інструмента КИНУВ виняток (мережа, таймаут, збій підтвердження) → tool_failed моделі, хід триває", async () => {
    const tools = fakeTools({
      "relocation.get_search": () => {
        throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:8789");
      },
    });
    const { run, model, trace } = setup([{ calls: [["relocation__get_search", {}]] }, "сервіс недоступний"], tools);
    expect(await run("x")).toMatchObject({ kind: "answer", text: "сервіс недоступний" });
    const reply = model.requests[1]!.messages.at(-1)!;
    expect(reply).toMatchObject({ role: "tool", tool_call_id: "call_1_0" });
    expect(JSON.parse(reply.content as string)).toMatchObject({ error: { code: "tool_failed", retryable: true } });
    // Деталі (адреса, порт) — у трейс для людини, не моделі.
    expect(reply.content).not.toContain("ECONNREFUSED");
    expect(trace.find((e) => e.type === "tool")).toMatchObject({ ok: false, error: "tool_failed" });
  });

  it("на кожен tool_call — рівно одне tool-повідомлення, навіть якщо частина викликів невдала", async () => {
    const { run, model } = setup([{ calls: [["relocation__get_search", {}], ["nope", {}], ["relocation__get_search", "{"]] }, "ok"]);
    await run("x");
    const toolMsgs = model.requests[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(["call_1_0", "call_1_1", "call_1_2"]);
  });
});

describe("runTurn: ліміти", () => {
  it("maxSteps: модель без кінця викликає інструменти → outcome max_steps, рівно maxSteps викликів моделі", async () => {
    const loop = Array.from({ length: 10 }, () => ({ calls: [["relocation__get_search", {}]] as [string, unknown][] }));
    const { run, model } = setup(loop);
    expect(await run("x")).toMatchObject({ kind: "max_steps", steps: 5 });
    expect(model.requests).toHaveLength(5);
  });

  it("бюджет запуску: витрати досягли maxCostUsdPerRun → зупинка до наступного виклику моделі", async () => {
    const loop = Array.from({ length: 10 }, () => ({ calls: [["relocation__get_search", {}]] as [string, unknown][] }));
    const model = scriptedModel(loop, 0.08);
    const history: Message[] = [];
    const out = await runTurn(history, "x", { model, tools: fakeTools({ "relocation.get_search": () => ok({}) }), limits: LIMITS, runId: "r" });
    // 0.08 + 0.08 = 0.16 < 0.2 → третій виклик; 0.24 ≥ 0.2 → стоп.
    expect(out).toMatchObject({ kind: "budget_exceeded", steps: 3 });
    expect(model.requests).toHaveLength(3);
  });

  it("gateway відповів 429 run_budget_exceeded → outcome budget_exceeded, а не виняток", async () => {
    const model = async () => {
      throw new BudgetExceededError("run_budget_exceeded", "Бюджет запуску вичерпано");
    };
    const out = await runTurn([], "x", { model, tools: fakeTools({}), limits: LIMITS, runId: "r" });
    expect(out).toMatchObject({ kind: "budget_exceeded", message: "Бюджет запуску вичерпано" });
  });
});

describe("runTurn: guard для інструментів з високим ризиком", () => {
  it("guard обгортає виклик: може не виконати його і повернути моделі власний результат", async () => {
    const tools = fakeTools({ "relocation.request_viewing": () => ok({ status: "pending_confirmation" }) });
    const guard: Guard = async () => err("rejected_by_user", "Користувач відмовився");
    const { run, model } = setup([{ calls: [["relocation__request_viewing", { listing_key: "olx:1" }]] }, "добре"], tools);
    await run("x", { guards: new Map([["relocation.request_viewing", guard]]) });
    expect(tools.calls).toEqual([]);
    expect(model.requests[1]!.messages.at(-1)!.content).toContain("rejected_by_user");
  });

  it("guard отримує розібрані аргументи і функцію виконання", async () => {
    const tools = fakeTools({ "relocation.request_viewing": () => ok({ status: "pending_confirmation" }) });
    const seen: unknown[] = [];
    const guard: Guard = async (args, exec) => {
      seen.push(args);
      return exec();
    };
    const { run } = setup([{ calls: [["relocation__request_viewing", { listing_key: "olx:1" }]] }, "ok"], tools);
    await run("x", { guards: new Map([["relocation.request_viewing", guard]]) });
    expect(seen).toEqual([{ listing_key: "olx:1" }]);
    expect(tools.calls).toHaveLength(1);
  });
});

describe("runTurn: трейс", () => {
  it("події model → tool → model → end з кроками, токенами і вартістю", async () => {
    const { run, trace } = setup([{ calls: [["relocation__get_search", {}]] }, "ok"]);
    await run("x");
    expect(trace.map((e) => e.type)).toEqual(["model", "tool", "model", "end"]);
    expect(trace[0]).toMatchObject({ step: 1, model: "scripted", inputTokens: 100, outputTokens: 10, costUsd: 0.001, toolCalls: 1 });
    expect(trace.at(-1)).toMatchObject({ type: "end", outcome: "answer", steps: 2, costUsd: 0.002 });
  });
});
