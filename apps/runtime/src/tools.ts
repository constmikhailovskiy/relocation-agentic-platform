import type { ToolDef } from "./messages.ts";

/** Результат інструмента в тому вигляді, в якому він піде моделі: текст + чи це помилка. */
export interface ToolResult {
  isError: boolean;
  text: string;
}

/** Один інструмент, доступний агенту. */
export interface ToolHandle {
  /** Ім'я зі специфікації агента: "relocation.request_viewing". */
  ref: string;
  /** Ім'я для моделі: "relocation__request_viewing" (крапки в іменах інструментів провайдери не приймають). */
  modelName: string;
  def: ToolDef;
  call: (args: unknown, meta: { idempotencyKey: string }) => Promise<ToolResult>;
}

/** Набір інструментів одного запуску. */
export interface ToolSet {
  defs: ToolDef[];
  get: (modelName: string) => ToolHandle | undefined;
  close: () => Promise<void>;
}
