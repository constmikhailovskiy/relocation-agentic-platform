import { join } from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";
import { loadAgentSpec } from "../../runtime/src/spec.ts";
import { scriptedModel, type Turn } from "../../runtime/test/fakes.ts";
import { world } from "../../runtime/test/world.ts";
import { type ScoutDeps, markNeedsAttention, runScout, snapshotShortlist } from "../src/scout.ts";

/**
 * Логіка activity Scout без Temporal і без мережі: справжні MCP-сервери в пам'яті, сценарна модель.
 * «Вбивство» воркера тут симулюємо винятком посеред спроби; повтор — другий виклик runScout з тим самим runKey.
 * Що Temporal справді повторює activity після смерті воркера — перевіряє окремий тест із сервером Temporal.
 */
const spec = loadAgentSpec(join(import.meta.dirname, "..", "..", "..", "agents", "scout.yaml"));
const RUN = { searchId: "s-olena", employeeId: "olena", runKey: "s-olena:0" };
const SEARCH = { criteria: { maxBudgetUah: 18000, minRooms: 2, pets: true } };
// Два вільні 2-кімнатні з котом до 18 000 (не здані, не пастки) — з фікстур.
const A = "olx:900047514";
const B = "olx:900055433";

type W = ReturnType<typeof world>;

function deps(w: W, model: ScoutDeps["model"], extra: Partial<ScoutDeps> = {}): ScoutDeps {
  return {
    spec,
    model,
    servers: w.urls,
    now: () => "2026-11-15T09:00:00.000Z",
    authHeaders: async () => ({ "x-debug-sub": "olena", "x-debug-act": "agent:scout@1" }),
    fetch: w.fetch,
    ...extra,
  };
}

/** Звичайний шлях моделі: get_search → search → save(keys) → текст. */
const savePath = (keys: string[], extraFirst: Turn[] = []): Turn[] => [
  ...extraFirst,
  { calls: [["relocation__get_search", { employee_id: "olena" }]] },
  { calls: [["listings__search_listings", SEARCH]] },
  { calls: [["relocation__save_shortlist", { search_id: "s-olena", items: keys.map((k) => ({ listing_key: k, reason: "підходить" })) }]] },
  `Знайшла нові варіанти: ${keys.join(", ")}.`,
];

describe("runScout: звичайний день", () => {
  it("нові варіанти → шортлист поповнено, рівно один лист із ключем ітерації", async () => {
    const w = world();
    const before = await snapshotShortlist(deps(w, scriptedModel([])), RUN);
    const r = await runScout(deps(w, scriptedModel(savePath([A, B]))), { ...RUN, before });
    expect(r).toMatchObject({ newItems: 2, added: [A, B], notified: true });
    expect(w.store.outbox()).toHaveLength(1);
    expect(w.store.outbox()[0]!.message).toContain(A);
  });

  it("нічого нового → newItems 0, листа немає", async () => {
    const w = world();
    const r = await runScout(deps(w, scriptedModel(["Нового немає."])), { ...RUN, before: [] });
    expect(r).toMatchObject({ newItems: 0, notified: false });
    expect(w.store.outbox()).toEqual([]);
  });

  it("модель не бачить ні request_viewing, ні notify_employee: лист — справа коду", async () => {
    const w = world();
    const model = scriptedModel(["Нового немає."]);
    await runScout(deps(w, model), { ...RUN, before: [] });
    const names = model.requests[0]!.tools.map((t) => t.function.name);
    expect(names).not.toContain("relocation__request_viewing");
    expect(names).not.toContain("relocation__notify_employee");
  });

  it("heartbeat на кожну подію трейсу — Temporal бачить, що воркер живий", async () => {
    const w = world();
    let beats = 0;
    await runScout(deps(w, scriptedModel(savePath([A])), { heartbeat: () => beats++ }), { ...RUN, before: [] });
    expect(beats).toBeGreaterThanOrEqual(4);
  });
});

describe("runScout: воркер помер посеред спроби → повтор з тим самим runKey", () => {
  it("ДО save_shortlist: друга спроба йде ІНШИМ шляхом (зайвий крок) — один лист, newItems 2", async () => {
    const w = world();
    const before = await snapshotShortlist(deps(w, scriptedModel([])), RUN);
    const crash: Turn[] = [{ calls: [["listings__search_listings", SEARCH]] }, () => { throw new Error("SIGKILL"); }];
    await expect(runScout(deps(w, scriptedModel(crash)), { ...RUN, before })).rejects.toThrow();
    const r = await runScout(deps(w, scriptedModel(savePath([A, B], [{ calls: [["listings__check_availability", { key: A }]] }]))), { ...RUN, before });
    expect(r.newItems).toBe(2);
    expect(w.store.outbox()).toHaveLength(1);
  });

  it("МІЖ save і листом: повтор бачить alreadyPresent, але різниця зі знімком = 2 → лист іде, і лише один", async () => {
    const w = world();
    const before = await snapshotShortlist(deps(w, scriptedModel([])), RUN);
    // Спроба 1: шортлист збережено, а запит листа не дійшов до сервера (воркер помер).
    const dying: ScoutDeps["fetch"] = async (url, init) => {
      if (String(init?.body ?? "").includes("notify_employee")) throw new Error("SIGKILL");
      return w.fetch(url, init);
    };
    await expect(runScout(deps(w, scriptedModel(savePath([A, B])), { fetch: dying }), { ...RUN, before })).rejects.toThrow();
    expect(w.store.outbox()).toHaveLength(0);
    // Спроба 2: модель знову зберігає ті самі — сервер каже alreadyPresent, нових «з погляду моделі» немає.
    const r = await runScout(deps(w, scriptedModel(savePath([A, B]))), { ...RUN, before });
    expect(r).toMatchObject({ newItems: 2, notified: true });
    expect(w.store.outbox()).toHaveLength(1);
  });

  it("ПІСЛЯ листа (сервер надіслав, відповідь загубилась): повтор з тим самим ключем — другого листа немає", async () => {
    const w = world();
    const before = await snapshotShortlist(deps(w, scriptedModel([])), RUN);
    const lostReply: ScoutDeps["fetch"] = async (url, init) => {
      const res = await w.fetch(url, init);
      if (String(init?.body ?? "").includes("notify_employee")) throw new Error("SIGKILL після відправки");
      return res;
    };
    await expect(runScout(deps(w, scriptedModel(savePath([A, B])), { fetch: lostReply }), { ...RUN, before })).rejects.toThrow();
    expect(w.store.outbox()).toHaveLength(1);
    const r = await runScout(deps(w, scriptedModel(savePath([A, B]))), { ...RUN, before });
    expect(r.notified).toBe(true);
    expect(w.store.outbox()).toHaveLength(1);
  });

  it("наступна ітерація (інший runKey) — новий лист можливий: ключ не «глушить» майбутні дні", async () => {
    const w = world();
    await runScout(deps(w, scriptedModel(savePath([A]))), { ...RUN, before: [] });
    await runScout(deps(w, scriptedModel(savePath([B]))), { ...RUN, runKey: "s-olena:1", before: [A] });
    expect(w.store.outbox()).toHaveLength(2);
  });
});

describe("runScout: класифікація помилок для Temporal", () => {
  it("інструмент недоступний (tool_failed) → ретраїться: інакше «порожній день» замість аварії", async () => {
    const w = world();
    const down: ScoutDeps["fetch"] = async (url, init) => {
      if (String(url).includes("listings")) throw new TypeError("fetch failed: ECONNREFUSED");
      return w.fetch(url, init);
    };
    // Підключення до listings впаде ще на старті — це теж має бути ретраїна помилка, а не «0 нових».
    const e = await runScout(deps(w, scriptedModel(["нема"]), { fetch: down }), { ...RUN, before: [] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e instanceof ApplicationFailure && e.nonRetryable).toBe(false);
  });

  it("бюджет запуску вичерпано → nonRetryable: повтор лише спалить ще", async () => {
    const w = world();
    const broke = scriptedModel([{ calls: [["relocation__get_search", { employee_id: "olena" }]] }, "x"], 0.5);
    const e = await runScout(deps(w, broke), { ...RUN, before: [] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApplicationFailure);
    expect((e as ApplicationFailure).nonRetryable).toBe(true);
  });
});

describe("markNeedsAttention: «3 дні без нового» лише зі статусу searching", () => {
  it("searching → needs_attention", async () => {
    const w = world();
    expect(await markNeedsAttention(deps(w, scriptedModel([])), { ...RUN, reason: "3 дні без нових варіантів" })).toEqual({ changed: true });
    expect(w.store.searchById("s-olena")?.status).toBe("needs_attention");
  });

  it("інший статус (shortlist_ready) → нічого не міняємо і НЕ падаємо (інакше ретраї вб'ють workflow)", async () => {
    const w = world();
    w.store.setStatus("s-olena", "shortlist_ready");
    expect(await markNeedsAttention(deps(w, scriptedModel([])), { ...RUN, reason: "x" })).toEqual({ changed: false });
    expect(w.store.searchById("s-olena")?.status).toBe("shortlist_ready");
  });
});

describe("грант відкликано: authHeaders кидає nonRetryable", () => {
  const revoked = async () => {
    throw ApplicationFailure.nonRetryable("Немає гранту olena → scout", "grant_missing");
  };
  it.each([
    ["runScout", (w: W) => runScout(deps(w, scriptedModel(["x"]), { authHeaders: revoked }), { ...RUN, before: [] })],
    ["snapshotShortlist", (w: W) => snapshotShortlist(deps(w, scriptedModel([]), { authHeaders: revoked }), RUN)],
  ])("%s → ApplicationFailure grant_missing, nonRetryable (не перегорнуто в retryable)", async (_n, run) => {
    const e = await run(world()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApplicationFailure);
    expect(e).toMatchObject({ type: "grant_missing", nonRetryable: true });
  });
});
