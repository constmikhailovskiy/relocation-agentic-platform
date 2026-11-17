import { join } from "node:path";
import { serve } from "@hono/node-server";
import { RelocationEnv, loadDeps } from "./config.ts";
import { createRelocationApp } from "./http.ts";

/** Точка входу: pnpm relocation. */
const env = RelocationEnv.parse(process.env);
const deps = loadDeps(env, join(import.meta.dirname, "..", "..", "..", "fixtures"));
const app = createRelocationApp(deps);

// Лише 127.0.0.1: поки auth — заглушка з заголовків, сервер не має бути доступним з мережі.
serve({ fetch: app.fetch, port: env.RELOCATION_PORT, hostname: "127.0.0.1" }, ({ port }) => {
  console.log(`relocation MCP: http://127.0.0.1:${port}/mcp — пошуків: ${deps.store.searchCount()}`);
});
