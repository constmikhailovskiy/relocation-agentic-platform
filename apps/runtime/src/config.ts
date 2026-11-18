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
  /** jwt — вхід через Keycloak і делеговані токени; debug — заглушка x-debug-* (сервери теж мають бути в debug). */
  AUTH_MODE: z.enum(["jwt", "debug"]).default("jwt"),
  IDP_ISSUER: z.url().default("http://127.0.0.1:8080/realms/relocation-sandbox"),
  /** Публічний клієнт Keycloak для CLI. */
  IDP_CLIENT_ID: z.string().default("relocation-cli"),
  /** Приватний ключ STS (pnpm sts:keygen). Відносний — від кореня репо. */
  RUNTIME_STS_KEY_PATH: z.string().default(".secrets/runtime-sts.private.jwk.json"),
  /** Пароль демо-користувача для неінтерактивного запуску (pipe). Без нього CLI спитає. Лише пісочниця. */
  DEMO_PASSWORD: z.preprocess(emptyAsUndefined, z.string().optional()),
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
