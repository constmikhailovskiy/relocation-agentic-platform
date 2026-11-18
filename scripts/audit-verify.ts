/**
 * pnpm audit:verify            — пройти хеш-ланцюжок audit_events; підробка → код виходу 1.
 * pnpm audit:verify --run <id> — показати всі події одного запуску агента («хто і чому попросив перегляд»).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AuditLog, resolveAuditPath } from "@reloc/shared";

const { values } = parseArgs({ options: { run: { type: "string" } }, strict: true });
const path = resolveAuditPath(join(import.meta.dirname, ".."), process.env.AUDIT_DB_PATH);
if (!existsSync(path)) {
  console.error(`Журналу немає: ${path}. Запусти сервери й агента, щоб з'явились події.`);
  process.exit(1);
}
const log = new AuditLog(path);

if (values.run) {
  const rows = log.all().filter((r) => r.runId === values.run);
  for (const r of rows) console.log(`${r.seq}\t${r.ts}\t${r.actor}${r.agent ? ` via ${r.agent}` : ""}\t${r.action}\t${r.resource}\t${r.decision} (${r.reason})`);
  console.log(`подій у запуску ${values.run}: ${rows.length}`);
}

const result = log.verify();
if (result.ok) {
  const last = log.all().at(-1);
  console.log(`OK: ланцюжок цілий, записів ${result.count}${last ? `, останній hash ${last.hash.slice(0, 16)}…` : ""}`);
  console.log("Обрізаний хвіст так не видно: звір останній hash з опублікованим якорем.");
} else {
  console.error(`ПІДРОБКА: рядок seq=${result.seq} — ${result.problem === "hash_mismatch" ? "вміст змінено" : "попередній рядок видалено або підмінено"}`);
  process.exit(1);
}
