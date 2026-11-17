import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Principal } from "@reloc/shared";
import { type AuditEvent, type Ctx, RelocationError } from "../src/context.ts";
import { RelocationStore } from "../src/store.ts";

const fixtures = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", name), "utf8"));

/** «Зараз» для тестів. Годинник — залежність, а не Date.now(): тести детерміновані. */
export const NOW = "2026-11-20T10:00:00.000Z";

/** Свіжий стор із фікстур + журнал аудиту. Викликати в beforeEach: записи одного тесту не протікають в інший. */
export function freshWorld(): { store: RelocationStore; audit: AuditEvent[]; ctx: (sub: string, act?: string) => Ctx } {
  const store = RelocationStore.fromSeed({ searches: fixtures("searches.json"), employees: fixtures("employees.json") });
  const audit: AuditEvent[] = [];
  const ctx = (sub: string, act?: string): Ctx => {
    const principal: Principal = act ? { sub, act: { sub: act } } : { sub };
    return { store, principal, now: () => NOW, audit: (e) => audit.push(e) };
  };
  return { store, audit, ctx };
}

/** Виконати fn і повернути RelocationError, яку вона кинула. Не кинула — тест падає. */
export function errorOf(fn: () => unknown): RelocationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RelocationError) return e;
    throw e;
  }
  throw new Error("очікували RelocationError");
}
