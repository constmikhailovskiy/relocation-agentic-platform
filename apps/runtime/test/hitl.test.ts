import { afterEach, describe, expect, it } from "vitest";
import { type ViewingShown, viewingGuard } from "../src/hitl.ts";
import { connectTools } from "../src/mcp-tools.ts";
import { relocationConfirmer } from "../src/relocation-client.ts";
import type { ToolSet } from "../src/tools.ts";
import { world } from "./world.ts";

/**
 * HITL для request_viewing на справжньому сервері relocation.
 * Порядок: показати людині → «так» → request_viewing (pending) → підтвердити хешем ПОКАЗАНОГО.
 */
const SLOT = "2026-11-17T15:00:00.000Z"; // після WORLD_NOW (2026-11-15)
const ARGS = { search_id: "s-olena", listing_key: "olx:1001", slots: [SLOT] };
const opened: ToolSet[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.close()));
});

async function setup(answer: boolean) {
  const w = world();
  w.store.addShortlistItems("s-olena", [{ listingKey: "olx:1001" }, { listingKey: "olx:1002" }]);
  w.store.setStatus("s-olena", "shortlist_ready");
  const tools = await connectTools({
    servers: { relocation: w.urls.relocation },
    allowlist: ["relocation.request_viewing"],
    authHeaders: async () => ({ "x-debug-sub": "olena", "x-debug-act": "agent:concierge@1" }),
    fetch: w.fetch,
  });
  opened.push(tools);
  const shown: ViewingShown[] = [];
  const confirmHeaders: Headers[] = [];
  const spyFetch: typeof w.fetch = async (url, init) => {
    confirmHeaders.push(new Headers(init?.headers));
    return w.fetch(url, init);
  };
  const guard = viewingGuard({
    ask: async (s) => {
      shown.push(s);
      return answer;
    },
    confirm: relocationConfirmer({ baseUrl: w.relocationBaseUrl, authHeaders: async () => ({ "x-debug-sub": "olena" }), fetch: spyFetch }),
  });
  const tool = tools.get("relocation__request_viewing")!;
  const exec = (args: unknown = ARGS) => () => tool.call(args, { idempotencyKey: "run-1:1:0" });
  return { w, guard, exec, shown, confirmHeaders };
}

describe("viewingGuard: людина сказала «так»", () => {
  it("запит створено і підтверджено; пошук → viewing_requested; моделі — confirmed", async () => {
    const { w, guard, exec } = await setup(true);
    const r = await guard(ARGS, exec());
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ status: "confirmed", listingKey: "olx:1001", slots: [SLOT] });
    expect(w.store.searchById("s-olena")?.status).toBe("viewing_requested");
  });

  it("людина бачить саме те, що піде на сервер", async () => {
    const { guard, exec, shown } = await setup(true);
    await guard(ARGS, exec());
    expect(shown).toEqual([{ searchId: "s-olena", listingKey: "olx:1001", slots: [SLOT] }]);
  });

  it("підтвердження йде від імені людини: x-debug-sub без x-debug-act", async () => {
    const { guard, exec, confirmHeaders } = await setup(true);
    await guard(ARGS, exec());
    expect(confirmHeaders).toHaveLength(1);
    expect(confirmHeaders[0]!.get("x-debug-sub")).toBe("olena");
    expect(confirmHeaders[0]!.has("x-debug-act")).toBe(false);
  });

  it("підміна: на сервер пішла ІНША квартира, ніж показали → args_mismatch, нічого не підтверджено", async () => {
    const { w, guard, exec } = await setup(true);
    // Людині показали olx:1001, а виконалось olx:1002. Хеш із відповіді сервера збігся б сам із собою —
    // тому runtime рахує хеш із показаного, а не бере argsHash з відповіді.
    const r = await guard(ARGS, exec({ ...ARGS, listing_key: "olx:1002" }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("args_mismatch");
    expect(w.store.searchById("s-olena")?.status).toBe("shortlist_ready");
  });

  it("сервер відхилив сам запит (не в шортлисті) → помилка моделі як є, підтвердження не надсилається", async () => {
    const { guard, exec, confirmHeaders } = await setup(true);
    const bad = { ...ARGS, listing_key: "olx:7777" };
    const r = await guard(bad, exec(bad));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not_in_shortlist");
    expect(confirmHeaders).toEqual([]);
  });
});

describe("viewingGuard: людина сказала «ні»", () => {
  it("request_viewing не викликається взагалі; модель отримує rejected_by_user", async () => {
    const { w, guard, exec } = await setup(false);
    const r = await guard(ARGS, exec());
    expect(r.isError).toBe(true);
    expect(r.text).toContain("rejected_by_user");
    expect(w.store.findApproval((a) => a.kind === "viewing")).toBeUndefined();
    expect(w.store.searchById("s-olena")?.status).toBe("shortlist_ready");
  });
});

describe("viewingGuard: аргументи не того вигляду", () => {
  it("людину не питаємо; виконуємо — сервер сам поверне invalid_input", async () => {
    const { guard, exec, shown } = await setup(true);
    const r = await guard({ search_id: "s-olena" }, exec({ search_id: "s-olena" }));
    expect(shown).toEqual([]);
    expect(r.isError).toBe(true);
  });
});
