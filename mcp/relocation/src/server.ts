import { join } from "node:path";
import { serve } from "@hono/node-server";
import { AuthEnv, buildServerAuth, resolveAuditPath } from "@reloc/shared";
import { RelocationEnv, loadDeps } from "./config.ts";
import { createRelocationApp } from "./http.ts";

/** Точка входу: pnpm relocation. */
const env = RelocationEnv.parse(process.env);
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const auditPath = resolveAuditPath(repoRoot, env.AUDIT_DB_PATH);
const deps = loadDeps(env, join(repoRoot, "fixtures"), { auditPath });
const auth = buildServerAuth(AuthEnv.parse(process.env), repoRoot, "mcp-relocation");
const app = createRelocationApp(deps, auth);

// Лише 127.0.0.1: це навчальний стенд. З AUTH_MODE=debug будь-хто назветься ким завгодно — тим більше не в мережу.
if (auth.debug) console.warn("⚠  AUTH_MODE=debug: principal із заголовків x-debug-*, без перевірки. Лише для Inspector.");
serve({ fetch: app.fetch, port: env.RELOCATION_PORT, hostname: "127.0.0.1" }, ({ port }) => {
  console.log(`relocation MCP: http://127.0.0.1:${port}/mcp — пошуків: ${deps.store.searchCount()}; аудит: ${auditPath}`);
});
