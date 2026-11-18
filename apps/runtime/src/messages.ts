/**
 * Повідомлення у форматі OpenAI Chat Completions — мова, якою runtime говорить з gateway.
 * Лише підмножина, яка потрібна циклу агента. Gateway сам перекладе її для Anthropic чи Ollama.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  /** Невідомі поля (наприклад `reasoning` від gpt-oss) зберігаємо і повертаємо назад як є. */
  [extra: string]: unknown;
}

export type Message =
  | { role: "system" | "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

/** Визначення інструмента для моделі: ім'я, опис, JSON Schema аргументів. */
export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}
