import { join } from "node:path";
import { serve } from "@hono/node-server";
import { AuthEnv, buildServerAuth, resolveAuditPath } from "@reloc/shared";
import { ListingsEnv, loadDeps } from "./config.ts";
import { createListingsApp } from "./http.ts";

/** Точка входу: pnpm listings. */
const env = ListingsEnv.parse(process.env);
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const deps = loadDeps(env, join(repoRoot, "fixtures"), { auditPath: resolveAuditPath(repoRoot, env.AUDIT_DB_PATH) });
const auth = buildServerAuth(AuthEnv.parse(process.env), repoRoot, "mcp-listings");
const app = createListingsApp(deps, auth.mcp);

// Лише 127.0.0.1: це навчальний стенд. З AUTH_MODE=debug будь-хто назветься ким завгодно — тим більше не в мережу.
if (auth.debug) console.warn("⚠  AUTH_MODE=debug: principal із заголовків x-debug-*, без перевірки. Лише для Inspector.");
serve({ fetch: app.fetch, port: env.LISTINGS_PORT, hostname: "127.0.0.1" }, ({ port }) => {
  const { listings, skipped } = deps.catalog;
  console.log(`listings MCP: http://127.0.0.1:${port}/mcp — ${listings.length} оголошень, пропущено ${skipped.length}`);
  if (env.LISTINGS_429_RATE > 0 || env.LISTINGS_LATENCY_MS > 0) {
    console.log(`  хаос: 429 у ${env.LISTINGS_429_RATE * 100}% check_availability, затримка ${env.LISTINGS_LATENCY_MS} мс`);
  }
});
