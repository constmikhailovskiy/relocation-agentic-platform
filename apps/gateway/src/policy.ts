import { timingSafeEqual } from "node:crypto";
import type { ClientConfig } from "./config.ts";
import { sha256 } from "./config.ts";
import type { ModelEntry } from "./registry.ts";
import type { ChatMessage, ChatRequest } from "./openai-types.ts";
import { textOf } from "./openai-types.ts";

/** Помилка політики → HTTP-статус і зрозуміле повідомлення для клієнта. */
export class PolicyError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 413 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------- Автентифікація клієнта ----------

/**
 * Порівнюємо хеші за сталий час (timingSafeEqual), щоб час відповіді не підказував,
 * скільки символів ключа вгадано. Перебираємо всіх клієнтів без раннього виходу.
 */
export function authenticate(header: string | undefined, clients: ClientConfig[]): ClientConfig {
  const key = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!key) throw new PolicyError(401, "missing_key", "Потрібен заголовок Authorization: Bearer <key>");
  const given = Buffer.from(sha256(key), "hex");
  let found: ClientConfig | undefined;
  for (const c of clients) {
    if (timingSafeEqual(given, Buffer.from(c.keySha256, "hex"))) found = c;
  }
  if (!found) throw new PolicyError(401, "invalid_key", "Невідомий ключ");
  return found;
}

// ---------- Доступ до моделі ----------

export type DataClass = "internal" | "restricted";

export function authorizeModel(client: ClientConfig, entry: ModelEntry | undefined, alias: string, opts: { allowedOrigins: string[]; dataClass: DataClass }): ModelEntry {
  if (!entry) throw new PolicyError(404, "unknown_model", `Модель ${alias} відсутня в реєстрі`);
  if (!client.models.includes(entry.alias)) {
    throw new PolicyError(403, "model_not_allowed", `Клієнту ${client.name} не дозволена модель ${entry.alias}`);
  }
  // Supply-chain політика: походження перевіряємо навіть для моделей із реєстру.
  if (!opts.allowedOrigins.includes(entry.origin)) {
    throw new PolicyError(403, "origin_not_allowed", `Модель ${entry.alias} (${entry.vendor}, ${entry.origin}) не дозволена політикою походження`);
  }
  if (opts.dataClass === "restricted" && !entry.local) {
    throw new PolicyError(403, "data_class_violation", `Дані класу restricted не можна надсилати в хмарну модель ${entry.alias}`);
  }
  return entry;
}

// ---------- Розмір промпту ----------

/**
 * Груба оцінка токенів ДО виклику, без токенайзера. Беремо символи/3, а не /4:
 * кирилиця токенізується «дорожче» за англійську, тож краще переоцінити.
 */
export function estimatePromptTokens(req: ChatRequest): number {
  const msgChars = req.messages.reduce((n, m) => n + textOf(m.content) .length + JSON.stringify(("tool_calls" in m && m.tool_calls) || []).length, 0);
  const toolChars = JSON.stringify(req.tools ?? []).length;
  return Math.ceil((msgChars + toolChars) / 3);
}

export function checkPromptSize(req: ChatRequest, entry: ModelEntry): number {
  const est = estimatePromptTokens(req);
  if (est > entry.maxPromptTokens) {
    throw new PolicyError(413, "prompt_too_large", `Оцінка промпту ${est} токенів > ліміт ${entry.maxPromptTokens} для ${entry.alias}`);
  }
  return est;
}

// ---------- Редагування PII ----------

// Українські номери: +380…, 380…, 0XX… з пробілами, дефісами чи дужками. Не чіпаємо ціни й дати:
// перед номером не має бути цифри, після — теж.
const PHONE = /(?<![\d+])(?:\+?380|\(?0)[\s\-()]*\d{2}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export function redactText(s: string): { text: string; count: number } {
  let count = 0;
  const text = s
    .replace(PHONE, () => {
      count++;
      return "[PHONE]";
    })
    .replace(EMAIL, () => {
      count++;
      return "[EMAIL]";
    });
  return { text, count };
}

/**
 * Редагуємо текст усіх повідомлень перед відправкою в ХМАРНУ модель.
 * Для локальних моделей не редагуємо: дані не покидають нашу інфраструктуру.
 */
export function redactMessages(messages: ChatMessage[]): { messages: ChatMessage[]; redactions: number } {
  let redactions = 0;
  const redactContent = <T extends ChatMessage["content"]>(c: T): T => {
    if (typeof c === "string") {
      const r = redactText(c);
      redactions += r.count;
      return r.text as T;
    }
    if (Array.isArray(c)) {
      return c.map((p) => {
        const r = redactText(p.text);
        redactions += r.count;
        return { ...p, text: r.text };
      }) as T;
    }
    return c;
  };
  const out = messages.map((m) => {
    const copy = { ...m, content: redactContent(m.content) } as ChatMessage;
    // Аргументи інструментів — теж текст, який іде в модель. Це JSON-рядок, але заміна
    // "+380…" на "[PHONE]" не ламає JSON: лапок і дужок ми не чіпаємо.
    if (copy.role === "assistant" && copy.tool_calls) {
      copy.tool_calls = copy.tool_calls.map((tc) => {
        const r = redactText(tc.function.arguments);
        redactions += r.count;
        return { ...tc, function: { ...tc.function, arguments: r.text } };
      });
    }
    return copy;
  });
  return { messages: out, redactions };
}
