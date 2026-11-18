import type { AssistantMessage, Message, ToolCall } from "./messages.ts";
import { BudgetExceededError, type CallModel } from "./model.ts";
import type { ToolResult, ToolSet } from "./tools.ts";

/**
 * Guard — обгортка навколо інструмента з високим ризиком (HITL).
 * Отримує розібрані аргументи і функцію `exec`, яка справді викличе інструмент.
 * Може: не викликати зовсім (людина сказала «ні»), викликати і щось додати після (підтвердження).
 */
export type Guard = (args: unknown, exec: () => Promise<ToolResult>) => Promise<ToolResult>;

/**
 * Події трейсу. Discriminated union: поле `type` каже, які ще поля є.
 * `switch (e.type)` у споживача звужує тип — TypeScript знає, що в "tool" є `tool`, а в "model" — `costUsd`.
 */
export type TraceEvent =
  | { type: "model"; step: number; model: string; inputTokens: number; outputTokens: number; costUsd: number; ms: number; toolCalls: number }
  | { type: "tool"; step: number; tool: string; ok: boolean; ms: number; error?: string; detail?: string }
  | { type: "end"; outcome: RunOutcome["kind"]; steps: number; costUsd: number };

export type RunOutcome =
  | { kind: "answer"; text: string; steps: number; costUsd: number }
  | { kind: "max_steps"; steps: number; costUsd: number }
  | { kind: "budget_exceeded"; message: string; steps: number; costUsd: number };

export interface RunOptions {
  model: CallModel;
  tools: ToolSet;
  limits: { maxSteps: number; maxCostUsdPerRun: number };
  /** Ідентифікатор запуску: іде в gateway (бюджет запуску) і в ключі ідемпотентності. */
  runId: string;
  /** Інструменти з високим ризиком: ref ("relocation.request_viewing") → guard. */
  guards?: Map<string, Guard>;
  onTrace?: (e: TraceEvent) => void;
}

/** Помилка, яку runtime сам повертає моделі (той самий формат, що в MCP-серверів). */
function toolError(code: string, message: string, retryable = false): ToolResult {
  return { isError: true, text: JSON.stringify({ error: { code, message, retryable } }) };
}

/** Код помилки з тексту результату — лише для трейсу. */
function errorCode(r: ToolResult): string | undefined {
  if (!r.isError) return undefined;
  try {
    return (JSON.parse(r.text) as { error?: { code?: string } }).error?.code ?? "error";
  } catch {
    return "error"; // напр. помилка валідації SDK — звичайний текст
  }
}

/**
 * Один хід чату = один запуск агента: модель ↔ інструменти, доки модель не відповість текстом
 * або не спрацює ліміт. `history` мутується: туди дописуються всі повідомлення ходу,
 * тож наступний хід чату бачить попередні.
 */
export async function runTurn(history: Message[], input: string, opts: RunOptions): Promise<RunOutcome> {
  const { model, tools, limits, runId, guards, onTrace = () => {} } = opts;
  let costUsd = 0;
  let step = 0;
  const end = (outcome: RunOutcome): RunOutcome => {
    onTrace({ type: "end", outcome: outcome.kind, steps: outcome.steps, costUsd: outcome.costUsd });
    return outcome;
  };

  history.push({ role: "user", content: input });

  while (step < limits.maxSteps) {
    // Бюджет перевіряємо ДО виклику: краще не почати крок, ніж дізнатися про перевитрату після.
    // Gateway теж тримає бюджет запуску (429) — це другий, незалежний рубіж.
    if (costUsd >= limits.maxCostUsdPerRun) {
      return end({ kind: "budget_exceeded", message: `Бюджет запуску $${limits.maxCostUsdPerRun} вичерпано`, steps: step, costUsd });
    }
    step++;

    const started = Date.now();
    let reply;
    try {
      reply = await model({ messages: history, tools: tools.defs, runId });
    } catch (e) {
      if (e instanceof BudgetExceededError) return end({ kind: "budget_exceeded", message: e.message, steps: step, costUsd });
      throw e; // мережа, 5xx після всіх fallback — справжня аварія, хай бачить CLI
    }
    costUsd += reply.costUsd;
    const calls: ToolCall[] = reply.message.tool_calls ?? [];
    onTrace({
      type: "model", step, model: reply.model, ...reply.usage, costUsd: reply.costUsd, ms: Date.now() - started, toolCalls: calls.length,
    });

    // Повідомлення асистента — в історію ДОСЛІВНО (зокрема невідомі поля на кшталт `reasoning`).
    const assistant: AssistantMessage = reply.message;
    history.push(assistant);
    if (calls.length === 0) return end({ kind: "answer", text: assistant.content ?? "", steps: step, costUsd });

    // Послідовно, не Promise.all: запис має йти в тому порядку, як попросила модель,
    // а guard може питати людину в терміналі — два питання одночасно змішались би.
    for (const [index, call] of calls.entries()) {
      const t0 = Date.now();
      let result: ToolResult;
      let detail: string | undefined;
      try {
        result = await execute(call, index);
      } catch (e) {
        // Виняток (мережа, таймаут SDK, збій підтвердження) — не кінець ходу: модель дізнається, що інструмент
        // не спрацював, і може пояснити це людині. Деталі (адреси, порти) — у трейс, моделі їх не даємо.
        detail = e instanceof Error ? e.message : String(e);
        result = toolError("tool_failed", `Інструмент ${call.function.name} зараз недоступний. Можна спробувати пізніше.`, true);
      }
      const code = errorCode(result);
      onTrace({
        type: "tool", step, tool: tools.get(call.function.name)?.ref ?? call.function.name, ok: !result.isError, ms: Date.now() - t0,
        ...(code !== undefined && { error: code }), ...(detail !== undefined && { detail }),
      });
      // На КОЖЕН tool_call — рівно одна відповідь з тим самим id, інакше провайдер відхилить наступний запит.
      history.push({ role: "tool", tool_call_id: call.id, content: result.text });
    }
  }
  return end({ kind: "max_steps", steps: step, costUsd });

  async function execute(call: ToolCall, index: number): Promise<ToolResult> {
    const tool = tools.get(call.function.name);
    // Інструмента поза allowlist у наборі немає взагалі — тож модель отримає ту саму відповідь, що й на вигаданий.
    if (!tool) {
      const available = tools.defs.map((d) => d.function.name).join(", ");
      return toolError("unknown_tool", `Інструмента ${call.function.name} немає. Доступні: ${available}`);
    }
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return toolError("invalid_arguments", `Аргументи ${call.function.name} — невалідний JSON. Надішли об'єкт JSON за схемою.`);
    }
    // Ключ генерує runtime: модель не може його забути чи підробити. Повтор кроку (ретрай) дасть той самий ключ.
    const exec = () => tool.call(args, { idempotencyKey: `${runId}:${step}:${index}` });
    const guard = guards?.get(tool.ref);
    return guard ? guard(args, exec) : exec();
  }
}
