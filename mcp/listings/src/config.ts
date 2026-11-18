import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, FX_USD_UAH, argsHash } from "@reloc/shared";
import { z } from "zod";
import { buildCatalog } from "./catalog.ts";
import type { Availability } from "./lookup.ts";
import type { ListingsDeps } from "./mcp.ts";

/**
 * Змінні середовища сервера listings. `z.coerce.number()` — env завжди рядки, coerce робить з них числа.
 * Хибне значення валить сервер на старті: краще одразу, ніж посеред запуску агента.
 */
export const ListingsEnv = z.object({
  LISTINGS_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  /** Частка відповідей 429 у check_availability (хаос для тренування ретраїв). */
  LISTINGS_429_RATE: z.coerce.number().min(0).max(1).default(0),
  /** Затримка відповіді «джерела» в check_availability, мс. */
  LISTINGS_LATENCY_MS: z.coerce.number().int().min(0).max(60_000).default(0),
  /** Зафіксувати «зараз» (для демо й evals на фікстурах). Без нього — справжній годинник. */
  // z.preprocess: спершу "" → undefined (рядок `LISTINGS_NOW=` у .env дає саме порожній рядок), потім перевірка.
  LISTINGS_NOW: z.preprocess((v) => (v === "" ? undefined : v), z.iso.datetime().optional()),
  /** Спільний журнал аудиту (обидва MCP-сервери). Відносний шлях — від кореня репо. */
  AUDIT_DB_PATH: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
});
export type ListingsEnv = z.output<typeof ListingsEnv>;

/** Зібрати залежності сервера: каталог і статуси з фікстур, хаос і годинник з env. */
export function loadDeps(env: ListingsEnv, fixturesDir: string, opts: { auditPath: string }): ListingsDeps {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
  // traps.json тут свідомо НЕ читаємо: це ключ відповідей для тестів, сервер його знати не має.
  const catalog = buildCatalog(
    { olx: read("listings.olx.json") as unknown[], lun: read("listings.lun.json") as unknown[] },
    { fxUsdUah: FX_USD_UAH },
  );
  const fixedNow = env.LISTINGS_NOW;
  const log = new AuditLog(opts.auditPath);
  return {
    // listings лише читає публічний каталог, тож рішення завжди allow. Аргументи — хешем:
    // критерії пошуку (бюджет!) — це дані людини, у журналі їм не місце.
    audit: ({ tool, principal, args }) =>
      void log.append({
        action: `listings.${tool}`,
        actor: principal.sub,
        ...(principal.act && { agent: principal.act.sub }),
        ...(principal.runId && { runId: principal.runId }),
        resource: "catalog",
        decision: "allow",
        reason: "public_catalog",
        argsHash: argsHash((args ?? {}) as Record<string, unknown>),
      }),
    catalog,
    availability: read("availability.json") as Availability,
    now: () => fixedNow ?? new Date().toISOString(),
    chaos: { rate429: env.LISTINGS_429_RATE, latencyMs: env.LISTINGS_LATENCY_MS },
  };
}
