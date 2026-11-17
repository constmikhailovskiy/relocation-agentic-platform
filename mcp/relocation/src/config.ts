import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RelocationDeps } from "./mcp.ts";
import { RelocationStore } from "./store.ts";

/** Змінні середовища сервера relocation. Хибне значення валить старт, а не запуск агента. */
export const RelocationEnv = z.object({
  RELOCATION_PORT: z.coerce.number().int().min(1).max(65535).default(8789),
  /** Зафіксувати «зараз» (демо й evals). Порожнє значення в .env — як не задано. */
  RELOCATION_NOW: z.preprocess((v) => (v === "" ? undefined : v), z.iso.datetime().optional()),
});
export type RelocationEnv = z.output<typeof RelocationEnv>;

/** Стор із фікстур — ОДИН на процес. Етап з SQLite замінить лише цей рядок. */
export function loadDeps(env: RelocationEnv, fixturesDir: string): RelocationDeps {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
  const store = RelocationStore.fromSeed({ searches: read("searches.json"), employees: read("employees.json") });
  const fixedNow = env.RELOCATION_NOW;
  return { store, now: () => fixedNow ?? new Date().toISOString() };
}
