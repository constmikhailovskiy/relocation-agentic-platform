import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Listing } from "@reloc/shared";
import { buildCatalog } from "../src/catalog.ts";
import type { Availability } from "../src/lookup.ts";
import { type ListingsDeps, type Principal, createListingsServer } from "../src/mcp.ts";

/**
 * MCP-обгортка listings. Тестуємо так, як її бачитиме агент: справжній MCP-клієнт із SDK,
 * з'єднаний із сервером «трубою в пам'яті» (InMemoryTransport) — без мережі й портів.
 */
const fixtures = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", name), "utf8"));
const traps = fixtures("traps.json") as { now: string; fxUsdUah: number; stale: string[]; phoneInText: string[]; duplicates: { olx: string; lun: string }[] };
const catalog = buildCatalog({ olx: fixtures("listings.olx.json"), lun: fixtures("listings.lun.json") }, { fxUsdUah: traps.fxUsdUah });
const availability = fixtures("availability.json") as Availability;
const pair = traps.duplicates[0]!;
const olena: Principal = { sub: "olena", act: { sub: "agent:concierge@7" } };

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** Підняти сервер і підключити до нього клієнта. `extra` — підміна залежностей для окремого тесту. */
async function connect(extra: Partial<ListingsDeps> = {}, principal: Principal = olena) {
  const deps: ListingsDeps = { catalog, availability, now: () => traps.now, ...extra };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createListingsServer(deps, principal).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

/**
 * Виклик інструмента: «сирий» результат + дані. Успіх — structuredContent;
 * помилка — лише JSON у тексті (див. fail() у mcp.ts, чому так).
 */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return { result, data: (result.structuredContent ?? parseOr(text)) as Record<string, unknown> };
}

/** Помилки валідації аргументів SDK пише звичайним текстом («MCP error -32602: ...»), не JSON. */
function parseOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

describe("tools/list — що бачить модель", () => {
  it("рівно три інструменти, кожен з описом і схемою входу", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_availability", "get_listing", "search_listings"]);
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("у критеріях обов'язковий лише бюджет: поля з дефолтами модель може не передавати", async () => {
    const { tools } = await (await connect()).listTools();
    const search = tools.find((t) => t.name === "search_listings")!;
    const criteria = search.inputSchema.properties?.criteria as { required?: string[] };
    expect(criteria.required).toEqual(["maxBudgetUah"]);
  });
});

describe("search_listings", () => {
  it("лише бюджет → працює; відповідь — items + total і в structuredContent, і текстом", async () => {
    const { result, data } = await call(await connect(), "search_listings", { criteria: { maxBudgetUah: 20000 } });
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe("number");
    const text = (result.content as { type: string; text: string }[])[0]!;
    expect(JSON.parse(text.text)).toEqual(data);
  });

  it("limit обрізає видачу", async () => {
    const { data } = await call(await connect(), "search_listings", { criteria: { maxBudgetUah: 200000 }, limit: 2 });
    expect((data.items as unknown[]).length).toBe(2);
    expect(data.total as number).toBeGreaterThan(2);
  });

  it("«зараз» бере сервер, а не модель: аргумент now ігнорується", async () => {
    // Модель не має вибирати годинник: інакше «з майбутнього» стало б «з минулого».
    const honest = await call(await connect(), "search_listings", { criteria: { maxBudgetUah: 200000 }, limit: 50 });
    const sneaky = await call(await connect(), "search_listings", { criteria: { maxBudgetUah: 200000 }, limit: 50, now: "2030-01-01T00:00:00Z" });
    expect(sneaky.data).toEqual(honest.data);
  });

  it("невалідні критерії → isError, а не падіння сервера", async () => {
    const { result } = await call(await connect(), "search_listings", { criteria: { maxBudgetUah: -5 } });
    expect(result.isError).toBe(true);
  });
});

describe("get_listing", () => {
  it("за псевдонімом повертає канонічне оголошення, рівно поля Listing", async () => {
    const { data } = await call(await connect(), "get_listing", { key: pair.lun });
    const listing = data.listing as Record<string, unknown>;
    expect(listing.key).toBe(pair.olx);
    expect(Object.keys(listing).sort()).toEqual(Object.keys(Listing.shape).sort());
  });

  it("невідомий ключ → isError з кодом not_found і retryable: false", async () => {
    const { result, data } = await call(await connect(), "get_listing", { key: "olx:1" });
    expect(result.isError).toBe(true);
    expect(data).toMatchObject({ error: { code: "not_found", retryable: false } });
  });
});

describe("check_availability", () => {
  it("застаріле оголошення → rented з часом сервера", async () => {
    const key = traps.stale[0]!;
    const { data } = await call(await connect(), "check_availability", { key });
    expect(data).toEqual({ key, status: "rented", checkedAt: traps.now });
  });

  it("помилки доходять як isError і тоді, коли клієнт спершу зробив tools/list (як runtime та Inspector)", async () => {
    // Після tools/list клієнт SDK кешує outputSchema і перевіряє нею structuredContent — навіть у помилках.
    const client = await connect({ chaos: { rate429: 1 }, random: () => 0, sleep: async () => {} });
    await client.listTools();
    for (const [name, key] of [["get_listing", "olx:1"], ["check_availability", pair.olx]] as const) {
      const { result } = await call(client, name, { key });
      expect(result.isError, name).toBe(true);
    }
  });

  it("429 від джерела → isError з rate_limited, retryable і retryAfterMs", async () => {
    const client = await connect({ chaos: { rate429: 1 }, random: () => 0, sleep: async () => {} });
    const { result, data } = await call(client, "check_availability", { key: pair.olx });
    expect(result.isError).toBe(true);
    expect(data).toMatchObject({ error: { code: "rate_limited", retryable: true, retryAfterMs: expect.any(Number) } });
  });
});

describe("Безпека", () => {
  it("телефон орендодавця не з'являється в структурованих полях жодної відповіді", async () => {
    const client = await connect();
    const outputs = [
      await client.callTool({ name: "search_listings", arguments: { criteria: { maxBudgetUah: 200000 }, limit: 50 } }),
      await client.callTool({ name: "get_listing", arguments: { key: pair.olx } }),
      await client.callTool({ name: "get_listing", arguments: { key: pair.lun } }),
    ];
    // Вирізаємо untrustedText з обох форм відповіді (structuredContent і JSON у text).
    const withoutText = JSON.stringify(outputs.map((o) => o.structuredContent), (k, v) => (k === "untrustedText" ? undefined : v));
    const full = JSON.stringify(outputs);
    expect(catalog.contacts.size).toBeGreaterThan(0);
    for (const c of catalog.contacts.values()) {
      expect(withoutText, c.listingKey).not.toContain(c.phone);
      // Телефон у тексті опису — лише там, де орендодавець написав його сам (пастка phoneInText).
      // Його маскує gateway (PII), не цей сервер — див. docs/case.md, «Пастки».
      if (!traps.phoneInText.includes(c.listingKey)) expect(full, c.listingKey).not.toContain(c.phone);
    }
  });

  it("неочікувана помилка (баг у нас) → загальне internal_error, без деталей назовні", async () => {
    const broken = { ...catalog, listings: null as unknown as Listing[] }; // .filter впаде з TypeError
    const logged: unknown[] = [];
    const client = await connect({ catalog: broken, logError: (_tool, e) => void logged.push(e) });
    const { result, data } = await call(client, "search_listings", { criteria: { maxBudgetUah: 1000 } });
    expect(logged[0]).toBeInstanceOf(TypeError); // деталі є в лозі сервера…
    expect(result.isError).toBe(true);
    expect(data).toEqual({ error: { code: "internal_error", message: expect.any(String), retryable: false } });
    expect(JSON.stringify(result)).not.toMatch(/filter|TypeError|null/);
  });

  it("principal доходить до кожного обробника (аудит бачить, хто і через якого агента)", async () => {
    const seen: { tool: string; principal: Principal }[] = [];
    const client = await connect({ audit: (e) => void seen.push({ tool: e.tool, principal: e.principal }) });
    await client.callTool({ name: "search_listings", arguments: { criteria: { maxBudgetUah: 20000 } } });
    await client.callTool({ name: "get_listing", arguments: { key: pair.olx } });
    await client.callTool({ name: "check_availability", arguments: { key: pair.olx } });
    expect(seen).toEqual([
      { tool: "search_listings", principal: olena },
      { tool: "get_listing", principal: olena },
      { tool: "check_availability", principal: olena },
    ]);
  });
});
