import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore } from "../src/grants.ts";

const grant = { sub: "olena", roles: ["new_hire" as const], agentId: "scout", grantedAt: "2026-11-15T09:00:00.000Z" };
const store = () => new GrantStore(join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json"));

describe("GrantStore: делегування для фонових агентів", () => {
  it("записаний грант читається іншим екземпляром (воркер — інший процес, ніж CLI)", () => {
    const s = store();
    s.put(grant);
    expect(new GrantStore(s.path).get("olena", "scout")).toEqual(grant);
  });

  it("грант іншого агента не підходить", () => {
    const s = store();
    s.put(grant);
    expect(s.get("olena", "concierge")).toBeUndefined();
  });

  it("revoke → гранту немає (воркер перевіряє на кожен запит)", () => {
    const s = store();
    s.put(grant);
    s.revoke("olena", "scout");
    expect(s.get("olena", "scout")).toBeUndefined();
  });

  it("повторний put замінює, а не дублює", () => {
    const s = store();
    s.put(grant);
    s.put({ ...grant, grantedAt: "2026-11-16T09:00:00.000Z" });
    expect(s.all()).toHaveLength(1);
  });
});
