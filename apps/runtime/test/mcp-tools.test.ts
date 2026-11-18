import { afterEach, describe, expect, it } from "vitest";
import { connectTools } from "../src/mcp-tools.ts";
import type { ToolSet } from "../src/tools.ts";
import { world } from "./world.ts";

/**
 * MCP-клієнт runtime: tools/list з обох серверів → фільтр за allowlist агента → визначення для моделі.
 * Сервери справжні (в пам'яті), principal — у заголовках, як у живому запуску.
 */
const HEADERS = { "x-debug-sub": "olena", "x-debug-act": "agent:concierge@1" };
const opened: ToolSet[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.close()));
});

async function connect(allowlist: string[], w = world()) {
  const tools = await connectTools({ servers: w.urls, allowlist, headers: HEADERS, fetch: w.fetch });
  opened.push(tools);
  return { tools, w };
}

describe("connectTools: allowlist", () => {
  it("модель бачить лише інструменти з allowlist, з іменами server__tool", async () => {
    const { tools } = await connect(["listings.search_listings", "relocation.get_search"]);
    expect(tools.defs.map((d) => d.function.name).sort()).toEqual(["listings__search_listings", "relocation__get_search"]);
  });

  it("notify_employee на сервері є, але не в allowlist → для моделі його не існує", async () => {
    const { tools } = await connect(["relocation.get_search"]);
    expect(tools.get("relocation__notify_employee")).toBeUndefined();
  });

  it("визначення несе опис і JSON Schema аргументів із tools/list сервера", async () => {
    const { tools } = await connect(["relocation.get_search"]);
    const def = tools.get("relocation__get_search")!.def.function;
    expect(def.description).toContain("Пошук житла");
    expect(def.parameters).toMatchObject({ type: "object", properties: { employee_id: { type: "string" } }, additionalProperties: false });
  });

  it("у специфікації інструмент, якого сервер не має → помилка на старті, а не посеред розмови", async () => {
    await expect(connect(["relocation.approve_budget"])).rejects.toThrow(/relocation\.approve_budget/);
  });

  it("невідомий сервер у специфікації → помилка на старті", async () => {
    await expect(connect(["payments.refund"])).rejects.toThrow(/payments/);
  });
});

describe("connectTools: виклики", () => {
  it("principal (sub + act) доходить до сервера: аудит бачить і людину, і агента", async () => {
    const { tools, w } = await connect(["relocation.get_search"]);
    const r = await tools.get("relocation__get_search")!.call({ employee_id: "olena" }, { idempotencyKey: "r:1:0" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ id: "s-olena" });
    expect(w.audit).toEqual([expect.objectContaining({ actor: "olena", agent: "agent:concierge@1" })]);
  });

  it("помилка сервера → isError і код у тексті (модель має його прочитати)", async () => {
    const { tools } = await connect(["relocation.get_search"]);
    const r = await tools.get("relocation__get_search")!.call({ employee_id: "maksym" }, { idempotencyKey: "r:1:0" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not_found");
  });

  it("ключ ідемпотентності йде в _meta: повтор notify_employee з тим самим ключем → один лист", async () => {
    const { tools, w } = await connect(["relocation.notify_employee"]);
    const notify = tools.get("relocation__notify_employee")!;
    await notify.call({ search_id: "s-olena", message: "Привіт" }, { idempotencyKey: "run-1:3:0" });
    await notify.call({ search_id: "s-olena", message: "Привіт" }, { idempotencyKey: "run-1:3:0" });
    expect(w.store.outbox()).toHaveLength(1);
  });
});
