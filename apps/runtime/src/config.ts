import { parseArgs } from "node:util";
import { z } from "zod";

const emptyAsUndefined = (v: unknown) => (v === "" ? undefined : v);

/** Змінні середовища runtime. Невалідне значення валить старт, а не розмову. */
export const RuntimeEnv = z.object({
  /** Ключ клієнта gateway (не ключ Anthropic!). Dev-ключ: dev-runtime-key, див. .env.example. */
  RUNTIME_GATEWAY_KEY: z.string().min(1),
  GATEWAY_URL: z.url().default("http://127.0.0.1:8787"),
  LISTINGS_URL: z.url().default("http://127.0.0.1:8788/mcp"),
  RELOCATION_URL: z.url().default("http://127.0.0.1:8789/mcp"),
  /** «Зараз» для системного промпту. Має збігатися з LISTINGS_NOW / RELOCATION_NOW серверів. */
  RUNTIME_NOW: z.preprocess(emptyAsUndefined, z.iso.datetime().optional()),
});
export type RuntimeEnv = z.output<typeof RuntimeEnv>;

/**
 * Аргументи `pnpm chat --as olena [--model mock] [--agent agents/x.yaml]`.
 * parseArgs з node:util у strict-режимі кидає помилку на невідомий прапорець.
 */
export function parseChatArgs(argv: string[]): { sub: string; model?: string; agent?: string } {
  const { values } = parseArgs({
    args: argv,
    options: { as: { type: "string" }, model: { type: "string" }, agent: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.as) throw new Error("Потрібен --as <користувач>, наприклад: pnpm chat --as olena");
  return { sub: values.as, ...(values.model && { model: values.model }), ...(values.agent && { agent: values.agent }) };
}
