import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ListingsEnv, loadDeps } from "../src/config.ts";

/** Конфіг сервера з env: перевіряємо на старті, а не тоді, коли агент уже щось викликав. */
const fixturesDir = join(import.meta.dirname, "..", "..", "..", "fixtures");

describe("ListingsEnv", () => {
  it("порожнє env → безпечні дефолти: без хаосу, порт 8788", () => {
    expect(ListingsEnv.parse({})).toEqual({ LISTINGS_PORT: 8788, LISTINGS_429_RATE: 0, LISTINGS_LATENCY_MS: 0 });
  });

  it("рядки з env перетворюються на числа", () => {
    expect(ListingsEnv.parse({ LISTINGS_429_RATE: "0.5", LISTINGS_LATENCY_MS: "4000" })).toMatchObject({ LISTINGS_429_RATE: 0.5, LISTINGS_LATENCY_MS: 4000 });
  });

  it("порожній рядок (LISTINGS_NOW= у .env) — як не задано, а не помилка", () => {
    expect(ListingsEnv.parse({ LISTINGS_NOW: "" }).LISTINGS_NOW).toBeUndefined();
  });

  it("частка 429 поза [0, 1] — помилка на старті", () => {
    expect(() => ListingsEnv.parse({ LISTINGS_429_RATE: "1.5" })).toThrow();
  });
});

describe("loadDeps", () => {
  it("каталог із фікстур, хаос з env, годинник — LISTINGS_NOW, якщо задано", () => {
    const deps = loadDeps(ListingsEnv.parse({ LISTINGS_429_RATE: "0.5", LISTINGS_NOW: "2026-11-15T09:00:00.000Z" }), fixturesDir, { auditPath: ":memory:" });
    expect(deps.catalog.listings.length).toBeGreaterThan(0);
    expect(deps.chaos).toEqual({ rate429: 0.5, latencyMs: 0 });
    expect(deps.now()).toBe("2026-11-15T09:00:00.000Z");
  });

  it("без LISTINGS_NOW — справжній годинник", () => {
    const deps = loadDeps(ListingsEnv.parse({}), fixturesDir, { auditPath: ":memory:" });
    expect(Math.abs(Date.parse(deps.now()) - Date.now())).toBeLessThan(5000);
  });
});

describe("loadDeps: аудит у спільний журнал (етап 4)", () => {
  it("виклик інструмента → listings.<tool>, людина і агент; аргументи — лише хешем", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { AuditLog, argsHash } = await import("@reloc/shared");
    const auditPath = join(mkdtempSync(join(tmpdir(), "listings-audit-")), "audit.db");
    const deps = loadDeps(ListingsEnv.parse({}), fixturesDir, { auditPath });
    const args = { criteria: { maxBudgetUah: 19000 } };
    deps.audit!({ tool: "search_listings", principal: { sub: "olena", act: { sub: "agent:concierge@7" } }, args });
    const [row] = new AuditLog(auditPath).all();
    expect(row).toMatchObject({ action: "listings.search_listings", actor: "olena", agent: "agent:concierge@7", decision: "allow", argsHash: argsHash(args) });
    expect(JSON.stringify(row)).not.toContain("19000");
  });
});
