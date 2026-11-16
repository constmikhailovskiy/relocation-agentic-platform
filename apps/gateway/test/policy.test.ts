import { describe, expect, it } from "vitest";
import { sha256 } from "../src/config.ts";
import { PolicyError, authenticate, authorizeModel, checkPromptSize, redactMessages, redactText } from "../src/policy.ts";
import { DEFAULT_REGISTRY, type ModelEntry, Registry } from "../src/registry.ts";

const client = { name: "runtime", keySha256: sha256("secret"), models: ["haiku", "gpt-oss", "cn-model"], dailyBudgetUsd: 5, maxRunUsd: 0.2 };
const registry = new Registry([
  ...DEFAULT_REGISTRY,
  // Модель, що ВЖЕ потрапила в реєстр, але має заборонене походження: політика має спрацювати і тут.
  { ...DEFAULT_REGISTRY[2]!, alias: "cn-model", vendor: "SomeLab", origin: "CN", upstreamModel: "x" } satisfies ModelEntry,
]);
const opts = { allowedOrigins: ["US", "FR", "UA"], dataClass: "internal" as const };

describe("Автентифікація клієнта", () => {
  it("без ключа — 401", () => {
    expect(() => authenticate(undefined, [client])).toThrow(PolicyError);
  });
  it("невідомий ключ — 401", () => {
    expect(() => authenticate("Bearer wrong", [client])).toThrow(/Невідомий ключ/);
  });
  it("правильний ключ — клієнт", () => {
    expect(authenticate("Bearer secret", [client]).name).toBe("runtime");
  });
});

describe("Доступ до моделей", () => {
  it("модель, якої немає в реєстрі — 404", () => {
    const e = (() => { try { authorizeModel(client, registry.get("gpt-9"), "gpt-9", opts); } catch (e) { return e; } })();
    expect((e as PolicyError).status).toBe(404);
  });
  it("модель не з allowlist клієнта — 403", () => {
    expect(() => authorizeModel(client, registry.get("sonnet"), "sonnet", opts)).toThrow(/не дозволена модель/);
  });
  it("заборонене походження — 403, навіть якщо модель у реєстрі й у клієнта", () => {
    expect(() => authorizeModel(client, registry.get("cn-model"), "cn-model", opts)).toThrow(/політикою походження/);
  });
  it("restricted-дані не йдуть у хмарну модель", () => {
    expect(() => authorizeModel(client, registry.get("haiku"), "haiku", { ...opts, dataClass: "restricted" })).toThrow(/restricted/);
    expect(authorizeModel(client, registry.get("gpt-oss"), "gpt-oss", { ...opts, dataClass: "restricted" }).alias).toBe("gpt-oss");
  });
});

describe("Розмір промпту", () => {
  it("відхиляє промпт, що перевищує ліміт моделі", () => {
    const big = "а".repeat(400_000);
    const req = { model: "haiku", messages: [{ role: "user" as const, content: big }] };
    expect(() => checkPromptSize(req, registry.get("haiku")!)).toThrow(/prompt_too_large|ліміт/);
  });
});

describe("Редагування PII", () => {
  it.each([
    ["+380 67 123 45 67", "[PHONE]"],
    ["+380671234567", "[PHONE]"],
    ["067-123-45-67", "[PHONE]"],
    ["(067) 123 45 67", "[PHONE]"],
    ["landlord.deals@mail.example", "[EMAIL]"],
  ])("%s → %s", (input, expected) => {
    expect(redactText(`Телефонуйте: ${input}, дякую`).text).toBe(`Телефонуйте: ${expected}, дякую`);
  });

  it("не чіпає ціни, площу і дати", () => {
    const s = "Ціна 17500 грн, 54 м², вільна з 2026-12-01, поверх 3/9";
    expect(redactText(s)).toEqual({ text: s, count: 0 });
  });

  it("редагує всі повідомлення і рахує заміни", () => {
    const r = redactMessages([
      { role: "system", content: "Ти помічник" },
      { role: "user", content: "Мій номер +380 50 111 22 33" },
      { role: "tool", tool_call_id: "1", content: "Орендодавець: ira@mail.example" },
    ]);
    expect(r.redactions).toBe(2);
    expect(JSON.stringify(r.messages)).not.toMatch(/111 22 33|ira@/);
  });
});

describe("Вправа 1: PII в аргументах інструментів", () => {
  it("телефон в arguments tool call теж редагується, а JSON лишається валідним", () => {
    const r = redactMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "notify_employee", arguments: '{"message":"Дзвоніть орендодавцю +380 67 123 45 67"}' },
          },
        ],
      },
    ]);
    const m = r.messages[0]!;
    if (m.role !== "assistant") throw new Error("очікували assistant");
    const args = m.tool_calls![0]!.function.arguments;
    expect(args).not.toContain("123 45 67");
    expect(JSON.parse(args)).toEqual({ message: "Дзвоніть орендодавцю [PHONE]" });
    expect(r.redactions).toBe(1);
  });
});
