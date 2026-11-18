import type { CallModel } from "../../apps/runtime/src/model.ts";
import type { RunRecord } from "./case.ts";
import type { CheckResult } from "./checks.ts";

/**
 * LLM-judge з бінарною рубрикою. Сувора відповідь: JSON {"pass": bool, "reason": string}.
 * Не розібрали — FAIL: краще хибна тривога, ніж «пройшло», бо judge відповів щось інше.
 * Judge бачить запит, результати інструментів (обрізані) і відповідь агента — щоб оцінити «спирається на дані».
 */
export function judgePrompt(input: string[], r: RunRecord, rubric: string): string {
  const tools = r.toolCalls.map((c) => `- ${c.ref}(${JSON.stringify(c.args)}) → ${c.text.slice(0, 12_000)}`).join("\n");
  return [
    "Ти — суворий оцінювач відповіді агента з пошуку житла. Оціни ЛИШЕ за рубрикою.",
    "",
    `РУБРИКА: ${rubric.trim()}`,
    "",
    `ЗАПИТ КОРИСТУВАЧА:\n${input.join("\n")}`,
    "",
    `ВИКЛИКИ ІНСТРУМЕНТІВ І РЕЗУЛЬТАТИ:\n${tools || "(жодного)"}`,
    "",
    `ВІДПОВІДЬ АГЕНТА:\n${r.response}`,
    "",
    'Відповідай ЛИШЕ JSON без markdown: {"pass": true|false, "reason": "одне речення"}',
  ].join("\n");
}

export function parseVerdict(text: string): { pass: boolean; reason: string } | undefined {
  try {
    const v = JSON.parse(text.trim()) as unknown;
    if (v && typeof v === "object" && typeof (v as { pass?: unknown }).pass === "boolean") {
      const reason = (v as { reason?: unknown }).reason;
      return { pass: (v as { pass: boolean }).pass, reason: typeof reason === "string" ? reason : "" };
    }
  } catch {
    /* нижче — undefined */
  }
  return undefined;
}

export async function judge(model: CallModel, input: string[], r: RunRecord, rubric: string): Promise<CheckResult & { costUsd: number }> {
  const reply = await model({ messages: [{ role: "user", content: judgePrompt(input, r, rubric) }], tools: [], runId: `judge-${r.caseId}-${Date.now()}` });
  const v = parseVerdict(reply.message.content ?? "");
  if (!v) return { check: "judge", pass: false, detail: `judge відповів не за форматом: ${(reply.message.content ?? "").slice(0, 120)}`, costUsd: reply.costUsd };
  return { check: "judge", pass: v.pass, detail: v.reason, costUsd: reply.costUsd };
}
