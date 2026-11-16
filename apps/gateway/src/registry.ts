import { z } from "zod";

/**
 * Реєстр моделей — єдине місце, де записано, ЯКІ моделі взагалі існують для платформи.
 * Клієнти звертаються за коротким псевдонімом ("haiku"), а не за назвою в провайдера:
 * так модель можна замінити, не чіпаючи агентів.
 *
 * Для кожної моделі зберігаємо походження і ліцензію: це основа supply-chain політики
 * (у defense-компанії «звідки модель» — це вимога, а не смак).
 */
export const ProviderName = z.enum(["anthropic", "ollama", "mock"]);
export type ProviderName = z.infer<typeof ProviderName>;

export const ModelEntry = z.object({
  alias: z.string(),
  provider: ProviderName,
  upstreamModel: z.string(),
  vendor: z.string(),
  origin: z.string().length(2).describe("ISO-код країни розробника моделі"),
  license: z.enum(["proprietary", "apache-2.0", "mit", "other"]),
  /** true → модель працює на нашій інфраструктурі, дані нікуди не йдуть. */
  local: z.boolean(),
  /** Ціни в доларах за мільйон токенів. */
  pricing: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
  maxPromptTokens: z.number().int().positive(),
  fallback: z.string().optional(),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Ціни Anthropic — з офіційної сторінки (листопад 2026).
 * Haiku 5.5 має поріг 100K токенів промпту: вище — у 5 разів дорожче.
 * Тому maxPromptTokens = 100_000: gateway просто не пустить дорожчий запит.
 */
export const DEFAULT_REGISTRY: ModelEntry[] = [
  {
    alias: "haiku",
    provider: "anthropic",
    upstreamModel: "claude-haiku-5-5",
    vendor: "Anthropic",
    origin: "US",
    license: "proprietary",
    local: false,
    pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    maxPromptTokens: 100_000,
    fallback: "gpt-oss",
  },
  {
    alias: "sonnet",
    provider: "anthropic",
    upstreamModel: "claude-sonnet-5-5",
    vendor: "Anthropic",
    origin: "US",
    license: "proprietary",
    local: false,
    pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    maxPromptTokens: 150_000,
    fallback: "haiku",
  },
  {
    alias: "gpt-oss",
    provider: "ollama",
    upstreamModel: "gpt-oss:20b",
    vendor: "OpenAI",
    origin: "US",
    license: "apache-2.0",
    local: true,
    pricing: FREE,
    maxPromptTokens: 32_000,
  },
  {
    alias: "mistral-small",
    provider: "ollama",
    upstreamModel: "mistral-small3.2",
    vendor: "Mistral AI",
    origin: "FR",
    license: "apache-2.0",
    local: true,
    pricing: FREE,
    maxPromptTokens: 32_000,
  },
  {
    alias: "mock",
    provider: "mock",
    upstreamModel: "mock-1",
    vendor: "Internal",
    origin: "UA",
    license: "other",
    local: true,
    pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, // ненульова ціна, щоб тестувати бюджети
    maxPromptTokens: 20_000,
    fallback: "mock-backup",
  },
  {
    alias: "mock-backup",
    provider: "mock",
    upstreamModel: "mock-backup-1",
    vendor: "Internal",
    origin: "UA",
    license: "other",
    local: true,
    pricing: FREE,
    maxPromptTokens: 20_000,
  },
];

export class Registry {
  private readonly byAlias: Map<string, ModelEntry>;
  constructor(entries: ModelEntry[]) {
    this.byAlias = new Map(entries.map((e) => [e.alias, ModelEntry.parse(e)]));
    for (const e of this.byAlias.values()) {
      if (e.fallback && !this.byAlias.has(e.fallback)) throw new Error(`Fallback ${e.fallback} для ${e.alias} не існує`);
    }
  }
  get(alias: string): ModelEntry | undefined {
    return this.byAlias.get(alias);
  }
  all(): ModelEntry[] {
    return [...this.byAlias.values()];
  }
}

export function costUsd(entry: ModelEntry, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const p = entry.pricing;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1_000_000;
}
