import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { MockProvider } from "./providers/mock.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import { DEFAULT_REGISTRY, Registry } from "./registry.ts";

const config = loadConfig();

const app = createApp({
  config,
  registry: new Registry(DEFAULT_REGISTRY),
  providers: {
    anthropic: new AnthropicProvider(config.ANTHROPIC_API_KEY, config.ANTHROPIC_BASE_URL),
    ollama: new OpenAICompatibleProvider("ollama", config.OLLAMA_BASE_URL),
    mock: new MockProvider(),
  },
  ledger: new Ledger(config.DB_PATH),
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`LLM gateway слухає на http://localhost:${info.port}`);
  console.log(`Клієнти: ${config.GATEWAY_CLIENTS.map((c) => c.name).join(", ")}; дозволене походження моделей: ${config.ALLOWED_MODEL_ORIGINS.join(", ")}`);
  if (!config.ANTHROPIC_API_KEY) console.log("ANTHROPIC_API_KEY не задано: haiku/sonnet відповідатимуть 503, працюють mock і Ollama.");
});
