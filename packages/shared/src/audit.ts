import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "./args-hash.ts";

/** prev_hash першого запису. */
export const GENESIS_HASH = "0".repeat(64);

/** Що сервіс передає в аудит. Тексту промптів і аргументів тут немає — лише хеш аргументів. */
export interface AuditInput {
  /** Людина (sub з токена). */
  actor: string;
  /** Агент (act.sub), якщо дія через агента. Дія людини напряму — без нього. */
  agent?: string;
  /** "relocation.get_search", "listings.search_listings", "relocation.confirm_viewing". */
  action: string;
  resource: string;
  decision: string;
  reason: string;
  /** Запуск агента (run_id з делегованого токена): «усі кроки запуску X». */
  runId?: string;
  argsHash?: string;
}

export interface AuditRow {
  seq: number;
  ts: string;
  actor: string;
  agent: string | null;
  action: string;
  resource: string;
  decision: string;
  reason: string;
  runId: string | null;
  argsHash: string | null;
  prevHash: string;
  hash: string;
}

export type VerifyResult = { ok: true; count: number } | { ok: false; seq: number; problem: "hash_mismatch" | "prev_mismatch" };

/** Поля, що входять у хеш. Порядок не важить — canonicalJson сортує ключі. */
type Hashed = Omit<AuditRow, "prevHash" | "hash">;

/**
 * Журнал аудиту з хеш-ланцюжком у SQLite (таблиця audit_events).
 * Один файл на всі сервіси: ланцюжок один, тож порядок подій між сервісами теж захищений.
 */
export class AuditLog {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(path: string, opts: { now?: () => string } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Кілька процесів на одному файлі: WAL + чекати блокування до 5 с замість миттєвої помилки SQLITE_BUSY.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        agent TEXT,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        run_id TEXT,
        args_hash TEXT,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      -- «Лише INSERT». У Postgres це була б роль БД без UPDATE/DELETE; у SQLite ролей немає,
      -- тож тригери. Від помилки в коді захищають, від людини з доступом до файлу — ні (вона видалить тригер).
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
    `);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** hash = sha256(prev_hash + канонічний JSON події). Статичний — щоб verify і тест рахували однаково. */
  static hashOf(prevHash: string, e: Hashed): string {
    const { seq, ts, actor, agent, action, resource, decision, reason, runId, argsHash } = e;
    return createHash("sha256")
      .update(prevHash + canonicalJson({ seq, ts, actor, agent, action, resource, decision, reason, runId, argsHash }))
      .digest("hex");
  }

  /**
   * Додати подію. «Прочитати останній hash → вставити» — в одній транзакції BEGIN IMMEDIATE:
   * вона одразу бере блокування на запис, тож два процеси не прочитають той самий prev_hash
   * (інакше ланцюжок «роздвоївся б»).
   */
  append(e: AuditInput): AuditRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
      const body: Hashed = {
        seq: (last?.seq ?? 0) + 1,
        ts: this.now(),
        actor: e.actor,
        agent: e.agent ?? null,
        action: e.action,
        resource: e.resource,
        decision: e.decision,
        reason: e.reason,
        runId: e.runId ?? null,
        argsHash: e.argsHash ?? null,
      };
      const prevHash = last?.hash ?? GENESIS_HASH;
      const row: AuditRow = { ...body, prevHash, hash: AuditLog.hashOf(prevHash, body) };
      this.db
        .prepare(
          `INSERT INTO audit_events (seq, ts, actor, agent, action, resource, decision, reason, run_id, args_hash, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.seq, row.ts, row.actor, row.agent, row.action, row.resource, row.decision, row.reason, row.runId, row.argsHash, row.prevHash, row.hash);
      this.db.exec("COMMIT");
      return row;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  all(): AuditRow[] {
    return this.db
      .prepare(
        `SELECT seq, ts, actor, agent, action, resource, decision, reason, run_id AS runId, args_hash AS argsHash,
                prev_hash AS prevHash, hash FROM audit_events ORDER BY seq`,
      )
      .all() as unknown as AuditRow[];
  }

  /**
   * Пройти ланцюжок від початку. Перше розходження — номер рядка і що саме не так:
   *  - hash_mismatch: рядок змінено (його hash не відповідає вмісту);
   *  - prev_mismatch: попереднього рядка немає або його підмінили разом з hash.
   * Обрізаний хвіст не видно: потрібен зовнішній якір (опублікований останній hash).
   */
  verify(): VerifyResult {
    let prev = GENESIS_HASH;
    const rows = this.all();
    for (const row of rows) {
      if (row.prevHash !== prev) return { ok: false, seq: row.seq, problem: "prev_mismatch" };
      if (AuditLog.hashOf(row.prevHash, row) !== row.hash) return { ok: false, seq: row.seq, problem: "hash_mismatch" };
      prev = row.hash;
    }
    return { ok: true, count: rows.length };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Шлях до журналу аудиту. Відносний — від кореня репо, а не від поточної теки:
 * `pnpm --filter` запускає кожен сервер у теці його пакета, і без цього кожен сервіс мав би свій файл
 * і свій ланцюжок (так сталося з журналом витрат gateway: apps/gateway/data/).
 */
export function resolveAuditPath(repoRoot: string, value: string | undefined): string {
  if (!value) return join(repoRoot, "data", "audit.db");
  return isAbsolute(value) ? value : join(repoRoot, value);
}
