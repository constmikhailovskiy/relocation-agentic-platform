import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type AuditInput, AuditLog, GENESIS_HASH, resolveAuditPath } from "../src/audit.ts";

/**
 * Аудит з хеш-ланцюжком: hash = sha256(prev_hash + канонічний JSON події).
 * Змінив рядок — його hash не зійдеться; видалив рядок — prev_hash наступного не зійдеться.
 */
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "audit-")), "audit.db");
const ev = (i: number): AuditInput => ({
  actor: "olena",
  agent: "agent:concierge@7",
  action: "relocation.get_search",
  resource: "s-olena",
  decision: "allow",
  reason: `owner #${i}`,
});

function filled(n: number) {
  const path = tmpDb();
  const log = new AuditLog(path, { now: () => "2026-11-18T10:00:00.000Z" });
  for (let i = 1; i <= n; i++) log.append(ev(i));
  return { path, log };
}

/** Прямий доступ до файлу «в обхід сервісу» — так діяв би зловмисник з доступом до диска. */
function tamper(path: string, sql: string) {
  const db = new DatabaseSync(path);
  db.exec("DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete;");
  db.exec(sql);
  db.close();
}

describe("AuditLog: ланцюжок", () => {
  it("перший запис посилається на GENESIS, кожен наступний — на hash попереднього", () => {
    const { log } = filled(3);
    const rows = log.all();
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]!.prevHash).toBe(GENESIS_HASH);
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(rows[2]!.prevHash).toBe(rows[1]!.hash);
  });

  it("чистий журнал → verify ok", () => {
    expect(filled(5).log.verify()).toEqual({ ok: true, count: 5 });
  });

  it("агент необов'язковий: дія людини без act теж пишеться", () => {
    const { log } = filled(0);
    const { agent: _drop, ...human } = ev(1);
    log.append({ ...human, action: "relocation.confirm_viewing" });
    expect(log.all()[0]!.agent).toBeNull();
    expect(log.verify().ok).toBe(true);
  });
});

describe("AuditLog.verify ловить підробку", () => {
  it("змінене поле в середньому рядку (deny → allow) → hash_mismatch на цьому рядку", () => {
    const { path, log } = filled(5);
    tamper(path, "UPDATE audit_events SET decision = 'allow', reason = 'owner' WHERE seq = 3");
    expect(log.verify()).toEqual({ ok: false, seq: 3, problem: "hash_mismatch" });
  });

  it("видалений рядок у середині → prev_mismatch на наступному", () => {
    const { path, log } = filled(5);
    tamper(path, "DELETE FROM audit_events WHERE seq = 2");
    expect(log.verify()).toEqual({ ok: false, seq: 3, problem: "prev_mismatch" });
  });

  it("перерахований hash зміненого рядка → ловимо на наступному (prev_mismatch)", () => {
    const { path, log } = filled(5);
    const row = log.all()[2]!;
    const forged = AuditLog.hashOf(row.prevHash, { ...row, reason: "підроблено" });
    tamper(path, `UPDATE audit_events SET reason = 'підроблено', hash = '${forged}' WHERE seq = 3`);
    expect(log.verify()).toEqual({ ok: false, seq: 4, problem: "prev_mismatch" });
  });

  it("ЧЕСНА МЕЖА: обрізаний хвіст (видалені останні рядки) verify НЕ бачить", () => {
    const { path, log } = filled(5);
    tamper(path, "DELETE FROM audit_events WHERE seq >= 4");
    // Ланцюжок, що лишився, цілий. Ловиться лише зовнішнім якорем: періодично публікувати останній hash.
    expect(log.verify()).toEqual({ ok: true, count: 3 });
  });
});

describe("AuditLog: лише додавання", () => {
  it("UPDATE і DELETE через звичайне з'єднання відхиляє тригер", () => {
    const { path } = filled(2);
    const db = new DatabaseSync(path);
    expect(() => db.exec("UPDATE audit_events SET decision = 'allow'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_events")).toThrow(/append-only/);
    db.close();
  });
});

describe("AuditLog: кілька записувачів в одному файлі", () => {
  it("два екземпляри на одному файлі по черзі → ланцюжок цілий (prev береться з БД, не з пам'яті)", () => {
    const path = tmpDb();
    const a = new AuditLog(path);
    const b = new AuditLog(path);
    for (let i = 0; i < 5; i++) {
      a.append(ev(i));
      b.append(ev(i));
    }
    expect(a.verify()).toEqual({ ok: true, count: 10 });
  });

  it("два ПРОЦЕСИ пишуть одночасно (як listings і relocation) → 2×40 записів, ланцюжок цілий", async () => {
    const path = tmpDb();
    new AuditLog(path); // створити схему до старту записувачів
    const run = promisify(execFile);
    const script = join(import.meta.dirname, "fixtures", "audit-writer.ts");
    await Promise.all(["A", "B"].map((who) => run(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", script, path, who, "40"])));
    expect(new AuditLog(path).verify()).toEqual({ ok: true, count: 80 });
  }, 30_000);
});

describe("resolveAuditPath", () => {
  it("за замовчуванням і відносний шлях — від кореня репо (не від теки пакета, де стартує pnpm --filter)", () => {
    expect(resolveAuditPath("/repo", undefined)).toBe("/repo/data/audit.db");
    expect(resolveAuditPath("/repo", "tmp/a.db")).toBe("/repo/tmp/a.db");
    expect(resolveAuditPath("/repo", "/var/audit.db")).toBe("/var/audit.db");
  });
});
