import { readFileSync } from "node:fs";
import { AgentSpec } from "@reloc/shared";
import { parse } from "yaml";
import { z } from "zod";
import { HIGH_RISK_TOOLS } from "./hitl.ts";
import type { Guard } from "./loop.ts";

/** Прочитати agents/<id>.yaml і перевірити за AgentSpec. Невалідна специфікація — помилка зі шляхом до поля. */
export function loadAgentSpec(path: string): AgentSpec {
  const r = AgentSpec.safeParse(parse(readFileSync(path, "utf8")));
  if (!r.success) throw new Error(`Невалідна специфікація агента ${path}:\n${z.prettifyError(r.error)}`);
  return r.data;
}

/**
 * Кожен інструмент з високим ризиком, що є в allowlist, мусить мати guard. Інакше — відмова стартувати.
 * Так HITL неможливо «забути» підключити: його відсутність — помилка конфігурації, а не тиха діра.
 */
export function assertGuarded(tools: readonly string[], guards: Map<string, Guard>): void {
  const missing = tools.filter((t) => HIGH_RISK_TOOLS.includes(t) && !guards.has(t));
  if (missing.length > 0) throw new Error(`Інструменти з високим ризиком без HITL-guard: ${missing.join(", ")}`);
}

/**
 * Системний промпт = інструкції агента + контекст запуску від runtime.
 * Хто користувач і котра година — факти від runtime, а не те, що модель вивела з розмови:
 * без «зараз» модель запропонує слоти в минулому, а сервер їх відхилить.
 */
export function systemPrompt(spec: AgentSpec, ctx: { sub: string; now: string }): string {
  return [
    spec.instructions.trim(),
    "",
    "Контекст запуску (від системи, не від користувача):",
    `- Користувач: ${ctx.sub}; employee_id: ${ctx.sub}`,
    `- Зараз: ${ctx.now} (UTC)`,
  ].join("\n");
}
