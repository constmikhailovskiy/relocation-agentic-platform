import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RelocationEnv, loadDeps } from "../src/config.ts";

const fixturesDir = join(import.meta.dirname, "..", "..", "..", "fixtures");

describe("RelocationEnv", () => {
  it("порожнє env → порт 8789", () => {
    expect(RelocationEnv.parse({})).toEqual({ RELOCATION_PORT: 8789 });
  });

  it("порожній RELOCATION_NOW= — як не задано", () => {
    expect(RelocationEnv.parse({ RELOCATION_NOW: "" }).RELOCATION_NOW).toBeUndefined();
  });

  it("невалідний порт — помилка на старті", () => {
    expect(() => RelocationEnv.parse({ RELOCATION_PORT: "99999" })).toThrow();
  });
});

describe("loadDeps", () => {
  it("стор із фікстур створюється один раз; годинник — RELOCATION_NOW, якщо задано", () => {
    const deps = loadDeps(RelocationEnv.parse({ RELOCATION_NOW: "2026-11-15T09:00:00.000Z" }), fixturesDir, { auditPath: ":memory:" });
    expect(deps.store.searchById("s-olena")?.employeeId).toBe("olena");
    expect(deps.now()).toBe("2026-11-15T09:00:00.000Z");
  });

  it("без RELOCATION_NOW — справжній годинник", () => {
    const deps = loadDeps(RelocationEnv.parse({}), fixturesDir, { auditPath: ":memory:" });
    expect(Math.abs(Date.parse(deps.now()) - Date.now())).toBeLessThan(5000);
  });
});

describe("loadDeps: аудит у файл з хеш-ланцюжком (етап 4)", () => {
  it("подія домену потрапляє в audit_events; ланцюжок цілий", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { AuditLog } = await import("@reloc/shared");
    const auditPath = join(mkdtempSync(join(tmpdir(), "reloc-audit-")), "audit.db");
    const deps = loadDeps(RelocationEnv.parse({}), fixturesDir, { auditPath });
    deps.audit!({ action: "relocation.get_search", actor: "ivan", agent: "agent:concierge@7", resource: "olena", decision: "allow_partial", reason: "manager_of" });
    const log = new AuditLog(auditPath);
    expect(log.all()).toMatchObject([{ actor: "ivan", agent: "agent:concierge@7", action: "relocation.get_search", decision: "allow_partial" }]);
    expect(log.verify().ok).toBe(true);
  });
});
