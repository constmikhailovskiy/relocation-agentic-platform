import { createHash } from "node:crypto";

/**
 * Канонічний JSON: ключі об'єктів відсортовані, тож {a,b} і {b,a} дають той самий рядок.
 * Без цього хеш залежав би від порядку полів, а не від змісту.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * args_hash = sha256(канонічний JSON аргументів). Підтвердження людини прив'язується саме до нього.
 * Лежить у shared, бо рахують його ДВІ сторони: сервер (при створенні запиту) і runtime (з того, що він
 * показав користувачу). Захист працює, лише коли runtime рахує хеш сам, а не повертає хеш сервера.
 */
export function argsHash(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(args)).digest("hex");
}

/** Аргументи запиту на перегляд у тому вигляді, у якому їх бачить людина при підтвердженні. */
export interface ViewingArgs {
  searchId: string;
  listingKey: string;
  slots: readonly string[];
}

/**
 * Хеш запиту на перегляд. Слоти сортуємо: [a,b] і [b,a] — той самий запит.
 * Цю функцію викликають і сервер relocation, і runtime — правило нормалізації одне на двох.
 */
export function viewingArgsHash({ searchId, listingKey, slots }: ViewingArgs): string {
  return argsHash({ searchId, listingKey, slots: [...slots].sort() });
}
