import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Конфіг читаємо зі змінних оточення і ВАЛІДУЄМО zod-ом на старті.
 * Краще впасти одразу з повідомленням «GATEWAY_CLIENTS: невалідний JSON»,
 * ніж о третій ночі з undefined десь у глибині.
 */

/** Клієнт gateway — сервіс, що має свій ключ (runtime, evals, studio). */
export const ClientConfig = z.object({
  name: z.string(),
  /** sha256 від ключа. Сам ключ у конфігу не зберігаємо — як із паролями. */
  keySha256: z.string().regex(/^[a-f0-9]{64}$/),
  models: z.array(z.string()).min(1),
  dailyBudgetUsd: z.number().positive(),
  maxRunUsd: z.number().positive(),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

const Env = z.object({
  PORT: z.coerce.number().int().default(8787),
  DB_PATH: z.string().default("data/gateway.db"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.url().default("https://api.anthropic.com"),
  OLLAMA_BASE_URL: z.url().default("http://localhost:11434"),
  /** Дозволені країни походження моделей. Усе інше — 403. */
  ALLOWED_MODEL_ORIGINS: z
    .string()
    .default("US,FR,GB,DE,UA")
    .transform((s) => s.split(",").map((x) => x.trim().toUpperCase())),
  GATEWAY_CLIENTS: z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "GATEWAY_CLIENTS: невалідний JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.array(ClientConfig).min(1)),
  /** Хаос-перемикач для симуляції інцидентів: ім'я провайдера, який «лежить». */
  FAIL_PROVIDER: z.string().optional(),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    console.error("Невалідна конфігурація gateway:\n" + z.prettifyError(r.error));
    process.exit(1);
  }
  return r.data;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
