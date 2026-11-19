import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DelegationGrant } from "../../runtime/src/sts.ts";

/**
 * Гранти делегування у JSON-файлі (data/grants.json, у .gitignore). Навчальна заміна таблиці в БД:
 * CLI пише (людина поруч), воркер читає на КОЖЕН запит — тож відкликання діє з наступного кроку Scout.
 * Запис — через тимчасовий файл і rename: читач ніколи не побачить напівзаписаний JSON.
 */
export class GrantStore {
  constructor(readonly path: string) {}

  all(): DelegationGrant[] {
    if (!existsSync(this.path)) return [];
    return JSON.parse(readFileSync(this.path, "utf8")) as DelegationGrant[];
  }

  get(sub: string, agentId: string): DelegationGrant | undefined {
    return this.all().find((g) => g.sub === sub && g.agentId === agentId);
  }

  put(grant: DelegationGrant): void {
    this.write([...this.all().filter((g) => !(g.sub === grant.sub && g.agentId === grant.agentId)), grant]);
  }

  revoke(sub: string, agentId: string): void {
    this.write(this.all().filter((g) => !(g.sub === sub && g.agentId === agentId)));
  }

  private write(grants: DelegationGrant[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(grants, null, 2));
    renameSync(tmp, this.path);
  }
}
