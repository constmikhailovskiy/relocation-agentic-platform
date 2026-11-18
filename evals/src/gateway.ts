import { randomBytes } from "node:crypto";
import { createApp } from "../../apps/gateway/src/app.ts";
import { sha256 } from "../../apps/gateway/src/config.ts";
import { Ledger } from "../../apps/gateway/src/ledger.ts";
import { AnthropicProvider } from "../../apps/gateway/src/providers/anthropic.ts";
import { MockProvider } from "../../apps/gateway/src/providers/mock.ts";
import { OpenAICompatibleProvider } from "../../apps/gateway/src/providers/openai-compatible.ts";
import { DEFAULT_REGISTRY, Registry } from "../../apps/gateway/src/registry.ts";
import { gatewayModel } from "../../apps/runtime/src/gateway-model.ts";
import type { CallModel } from "../../apps/runtime/src/model.ts";

/**
 * Справжній gateway у пам'яті процесу evals: ті самі політики, PII-редагування, облік вартості,
 * що й у проді, але без окремого сервера. У мережу йде лише виклик провайдера (Anthropic).
 * Клієнт «evals» з власним ключем на один процес і жорстким денним лімітом — стеля витрат прогону.
 */
export function evalGateway(opts: { anthropicKey: string | undefined; budgetUsd: number; maxRunUsd?: number }) {
  const key = randomBytes(16).toString("hex");
  const ledger = new Ledger(":memory:");
  const app = createApp({
    config: {
      GATEWAY_CLIENTS: [{ name: "evals", keySha256: sha256(key), models: ["haiku", "sonnet", "mock"], dailyBudgetUsd: opts.budgetUsd, maxRunUsd: opts.maxRunUsd ?? 0.2 }],
      ALLOWED_MODEL_ORIGINS: ["US", "UA"],
      FAIL_PROVIDER: undefined,
      UPSTREAM_TIMEOUT_MS: 60_000,
    },
    registry: new Registry(DEFAULT_REGISTRY),
    providers: {
      anthropic: new AnthropicProvider(opts.anthropicKey, "https://api.anthropic.com"),
      ollama: new OpenAICompatibleProvider("ollama", "http://localhost:11434"),
      mock: new MockProvider(),
    },
    ledger,
    retry: { retries: 2, baseMs: 500 },
  });
  const fetch = async (url: string | URL | Request, init?: RequestInit) => app.request(url, init);
  return {
    /** CallModel для агента або judge з потрібною моделлю. */
    model(alias: string, agentId: string): CallModel {
      return gatewayModel({ baseUrl: "http://gateway.eval", apiKey: key, model: alias, agentId, dataClass: "internal", fetch });
    },
    spentUsd: () => ledger.spentTodayUsd("evals"),
  };
}
