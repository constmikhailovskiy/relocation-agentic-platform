import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Usage } from "./openai-types.ts";

/**
 * Облік використання (таблиця llm_usage) — основа для бюджетів, аналізу витрат і алертів.
 * Використовуємо вбудований у Node модуль node:sqlite: жодних нативних залежностей.
 */
export interface UsageRow extends Usage {
  ts: string;
  requestId: string;
  client: string;
  runId: string | null;
  agentId: string | null;
  modelAlias: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
  status: "ok" | "error" | "partial";
  fallbackFrom: string | null;
  redactions: number;
}

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        request_id TEXT NOT NULL,
        client TEXT NOT NULL,
        run_id TEXT,
        agent_id TEXT,
        model_alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        latency_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        fallback_from TEXT,
        redactions INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_client_ts ON llm_usage(client, ts);
      CREATE INDEX IF NOT EXISTS idx_usage_run ON llm_usage(run_id);
    `);
  }

  record(r: UsageRow): void {
    this.db
      .prepare(
        `INSERT INTO llm_usage (ts, request_id, client, run_id, agent_id, model_alias, provider, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, status, fallback_from, redactions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.ts, r.requestId, r.client, r.runId, r.agentId, r.modelAlias, r.provider, r.inputTokens, r.outputTokens,
        r.cacheReadTokens, r.cacheWriteTokens, r.costUsd, r.latencyMs, r.status, r.fallbackFrom, r.redactions);
  }

  /** Витрати клієнта від початку доби (UTC). */
  spentTodayUsd(client: string, now = new Date()): number {
    const dayStart = now.toISOString().slice(0, 10) + "T00:00:00.000Z";
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_usage WHERE client = ? AND ts >= ?`).get(client, dayStart) as { s: number };
    return row.s;
  }

  /**
   * Витрати запуску. Фільтруємо і за клієнтом: run_id вигадує клієнт, тож два різні клієнти
   * можуть випадково (або навмисно) взяти той самий id — і тоді ділили б один бюджет.
   */
  spentOnRunUsd(client: string, runId: string): number {
    return this.runSummary(client, runId).spentUsd;
  }

  /** Підсумок запуску; calls = 0 означає, що такого запуску в цього клієнта немає. */
  runSummary(client: string, runId: string): { spentUsd: number; calls: number; models: string[] } {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s, COUNT(*) AS n, GROUP_CONCAT(DISTINCT model_alias) AS m FROM llm_usage WHERE client = ? AND run_id = ?`)
      .get(client, runId) as { s: number; n: number; m: string | null };
    return { spentUsd: row.s, calls: row.n, models: row.m ? row.m.split(",") : [] };
  }

  recent(client: string, limit = 20): unknown[] {
    return this.db.prepare(`SELECT * FROM llm_usage WHERE client = ? ORDER BY id DESC LIMIT ?`).all(client, limit);
  }
}
