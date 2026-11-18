// Окремий процес-записувач для тесту конкурентності: node --import tsx audit-writer.ts <db> <who> <n>
import { AuditLog } from "../../src/audit.ts";

const [path, who, n] = process.argv.slice(2) as [string, string, string];
const log = new AuditLog(path);
for (let i = 0; i < Number(n); i++) {
  log.append({ actor: who, action: "relocation.get_search", resource: "s-olena", decision: "allow", reason: `${who}-${i}` });
}
