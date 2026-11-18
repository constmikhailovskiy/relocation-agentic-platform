import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "@reloc/shared";
import { z } from "zod";
import type { RelocationDeps } from "./mcp.ts";
import { RelocationStore } from "./store.ts";

/** Змінні середовища сервера relocation. Хибне значення валить старт, а не запуск агента. */
export const RelocationEnv = z.object({
  RELOCATION_PORT: z.coerce.number().int().min(1).max(65535).default(8789),
  /** Зафіксувати «зараз» (демо й evals). Порожнє значення в .env — як не задано. */
  RELOCATION_NOW: z.preprocess((v) => (v === "" ? undefined : v), z.iso.datetime().optional()),
  /** Спільний журнал аудиту (обидва MCP-сервери). Відносний шлях — від кореня репо. */
  AUDIT_DB_PATH: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
});
export type RelocationEnv = z.output<typeof RelocationEnv>;

/** Стор із фікстур — ОДИН на процес. Етап з SQLite замінить лише цей рядок. */
export function loadDeps(env: RelocationEnv, fixturesDir: string, opts: { auditPath: string }): RelocationDeps {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
  const store = RelocationStore.fromSeed({ searches: read("searches.json"), employees: read("employees.json") });
  const fixedNow = env.RELOCATION_NOW;
  // Аудит — обов'язкова частина живого сервера, а не опція: без нього не відповісти «хто і чому».
  // Час події — справжній годинник журналу, а не RELOCATION_NOW (той лише для бізнес-логіки демо).
  const log = new AuditLog(opts.auditPath);
  return { store, now: () => fixedNow ?? new Date().toISOString(), audit: (e) => void log.append(e) };
}
