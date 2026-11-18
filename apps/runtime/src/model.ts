import type { AssistantMessage, Message, ToolDef } from "./messages.ts";

/** Один виклик моделі: що отримали, скільки токенів, скільки коштувало. */
export interface ModelReply {
  message: AssistantMessage;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  /** Яка модель відповіла насправді (могла спрацювати fallback). */
  model: string;
}

/**
 * Модель для циклу — просто функція. У проді це gateway (gatewayModel), у тестах — сценарій.
 * Цикл не знає, хто по той бік: так його можна тестувати без мережі.
 */
export type CallModel = (req: { messages: Message[]; tools: ToolDef[]; runId: string }) => Promise<ModelReply>;

/** Gateway відмовив через бюджет (429). Це не баг, а штатна зупинка запуску. */
export class BudgetExceededError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}
