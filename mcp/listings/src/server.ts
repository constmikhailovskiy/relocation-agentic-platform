import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ListingsEnv, loadDeps } from "./config.ts";
import { createListingsApp } from "./http.ts";

/** Точка входу: pnpm listings. */
const env = ListingsEnv.parse(process.env);
const deps = loadDeps(env, join(import.meta.dirname, "..", "..", "..", "fixtures"));
const app = createListingsApp(deps);

// Лише 127.0.0.1: поки auth — заглушка з заголовків, сервер не має бути доступним з мережі.
serve({ fetch: app.fetch, port: env.LISTINGS_PORT, hostname: "127.0.0.1" }, ({ port }) => {
  const { listings, skipped } = deps.catalog;
  console.log(`listings MCP: http://127.0.0.1:${port}/mcp — ${listings.length} оголошень, пропущено ${skipped.length}`);
  if (env.LISTINGS_429_RATE > 0 || env.LISTINGS_LATENCY_MS > 0) {
    console.log(`  хаос: 429 у ${env.LISTINGS_429_RATE * 100}% check_availability, затримка ${env.LISTINGS_LATENCY_MS} мс`);
  }
});
