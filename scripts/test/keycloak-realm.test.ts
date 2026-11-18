import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Employee } from "@reloc/shared";
import { describe, expect, it } from "vitest";

/**
 * Realm Keycloak — це конфігурація, а конфігурація теж ламається. Перевіряємо офлайн, без Docker:
 * користувачі й ролі збігаються з довідником людей, клієнт CLI видає токени з потрібними aud.
 */
const root = join(import.meta.dirname, "..", "..");
const realm = JSON.parse(readFileSync(join(root, "infra", "keycloak", "relocation-sandbox-realm.json"), "utf8"));
const employees = Employee.array().parse(JSON.parse(readFileSync(join(root, "fixtures", "employees.json"), "utf8")));

describe("realm relocation-sandbox", () => {
  it("кожен працівник — користувач з тими самими ролями (одне джерело правди для ролей — довідник людей)", () => {
    const users = new Map<string, { realmRoles: string[] }>(realm.users.map((u: { username: string; realmRoles: string[] }) => [u.username, u]));
    for (const e of employees) {
      expect(users.get(e.id)?.realmRoles.sort(), e.id).toEqual([...e.roles].sort());
    }
    expect(users.size).toBe(employees.length);
  });

  it("username не можна змінити самому і реєстрація вимкнена: preferred_username = id працівника", () => {
    expect(realm.editUsernameAllowed).toBe(false);
    expect(realm.registrationAllowed).toBe(false);
  });

  it("клієнт relocation-cli: публічний, лише password grant; aud містить relocation-cli і mcp-relocation", () => {
    const cli = realm.clients.find((c: { clientId: string }) => c.clientId === "relocation-cli");
    expect(cli).toMatchObject({ publicClient: true, directAccessGrantsEnabled: true, standardFlowEnabled: false });
    const audiences = cli.protocolMappers
      .filter((m: { protocolMapper: string }) => m.protocolMapper === "oidc-audience-mapper")
      .map((m: { config: Record<string, string> }) => m.config["included.custom.audience"]);
    expect(audiences.sort()).toEqual(["mcp-relocation", "relocation-cli"]);
  });

  it("у realm немає клієнтських секретів (конфіденційних клієнтів) — у git їм не місце", () => {
    expect(JSON.stringify(realm)).not.toMatch(/"secret"/);
  });
});
