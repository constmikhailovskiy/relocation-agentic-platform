import { SearchStatus } from "@reloc/shared";
import { z } from "zod";

/**
 * Eval-кейс — YAML у evals/cases/. Поля snake_case, як у форматі з docs/case.md (це формат кейсів, а не код).
 * Більшість перевірок детерміновані: за трейсом (які інструменти, з якими аргументами), станом сервера
 * і аудитом. LLM-judge — лише для «поведінки і тону».
 */
export const Category = z.enum(["extraction", "selection", "trajectory", "authz", "injection", "behavior"]);
export type Category = z.infer<typeof Category>;

const ToolRef = z.string().regex(/^[a-z]+\.[a-z_]+$/);

export const Expect = z.strictObject({
  /** Інструменти, які мають бути викликані (хоча б раз, успішно чи ні). */
  tools_called: z.array(ToolRef).optional(),
  /** Хоча б один із цих інструментів викликано — стійкий захист від «агента, що нічого не робив». */
  tools_called_any: z.array(ToolRef).min(1).optional(),
  tools_not_called: z.array(ToolRef).optional(),
  /** [a, b]: перший виклик a — раніше за перший виклик b (і обидва були). */
  called_before: z.array(z.tuple([ToolRef, ToolRef])).optional(),
  /** Хоча б один виклик tool має аргументи, що частково збігаються з match (глибоке часткове порівняння). */
  call_args: z.array(z.strictObject({ tool: ToolRef, match: z.record(z.string(), z.unknown()) })).optional(),
  /** ЖОДЕН виклик tool не має аргументів, що збігаються з match (напр. бюджет, піднятий «за порадою» оголошення). */
  call_args_never: z.array(z.strictObject({ tool: ToolRef, match: z.record(z.string(), z.unknown()) })).optional(),
  max_steps: z.number().int().positive().optional(),
  /** Регістр не важить. */
  response_contains: z.array(z.string()).optional(),
  response_not_contains: z.array(z.string()).optional(),
  /** Регулярні вирази (без прапорців; перевіряються з i). */
  response_matches: z.array(z.string()).optional(),
  response_not_matches: z.array(z.string()).optional(),
  audit_contains: z.array(z.strictObject({ action: z.string(), decision: z.string() })).optional(),
  /** Стан пошуку ПІСЛЯ запуску — на сервері, а не зі слів моделі. */
  state: z
    .strictObject({
      search_id: z.string(),
      status: SearchStatus.optional(),
      criteria: z.record(z.string(), z.unknown()).optional(),
      shortlist_min: z.number().int().min(0).optional(),
      shortlist_excludes: z.array(z.string()).optional(),
    })
    .optional(),
  /** Якість шортлиста: кожен елемент у межах бюджету, з тваринами, без дублів і зданих/«з майбутнього». */
  shortlist_quality: z.strictObject({ search_id: z.string(), max_budget_uah: z.number().int(), pets: z.boolean().optional() }).optional(),
  /** Передумова для ін'єкцій: модель справді бачила ці оголошення в результатах інструментів. */
  trap_seen: z.array(z.string()).optional(),
  /** Модель не пробувала інструментів поза allowlist (unknown_tool) — ознака, що її «вмовили». */
  no_unknown_tools: z.boolean().optional(),
  /** Чи питали людину про перегляд (guard HITL). false — агент не мав навіть пробувати. */
  hitl_asked: z.boolean().optional(),
  /** Бінарна рубрика для LLM-judge. */
  judge: z.string().min(10).optional(),
});
export type Expect = z.infer<typeof Expect>;

export const EvalCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: Category,
  /** security: true — має проходити ЗАВЖДИ (гейт 100%). */
  security: z.boolean().default(false),
  as_user: z.string(),
  agent: z.string().default("concierge"),
  /** Один рядок або кілька ходів розмови. */
  input: z.union([z.string(), z.array(z.string()).min(1)]),
  /** Стан світу перед запуском. */
  setup: z
    .strictObject({
      status: z.array(z.strictObject({ search_id: z.string(), status: SearchStatus })).optional(),
      shortlist: z.array(z.strictObject({ search_id: z.string(), keys: z.array(z.string()).min(1) })).optional(),
      /** Підключити додаткові оголошення лише для evals (evals/fixtures/<name>.olx.json). */
      extra_listings: z.enum(["subtle"]).optional(),
    })
    .optional(),
  /** Відповідь людини на HITL. За замовчуванням «ні»: так дешевше й безпечніше. */
  hitl: z.enum(["approve", "reject"]).default("reject"),
  expect: Expect,
  repeat: z.number().int().min(1).max(10).default(1),
  /** Чому кейс такий — для людини, що читає звіт. */
  note: z.string().optional(),
});
export type EvalCase = z.output<typeof EvalCase>;

/** Позитивні перевірки — ті, що агент, який нічого не робить, НЕ пройде. Кожен кейс мусить мати хоча б одну. */
export const POSITIVE_CHECKS = ["tools_called", "tools_called_any", "called_before", "call_args", "response_contains", "response_matches", "audit_contains", "state", "shortlist_quality", "trap_seen", "judge"] as const;

/** Що бачать перевірки після прогону. */
export interface ToolCallRecord {
  ref: string;
  args: unknown;
  ok: boolean;
  error?: string;
  text: string;
}

export interface RunRecord {
  caseId: string;
  outcome: "answer" | "max_steps" | "budget_exceeded" | "error";
  /** Відповіді агента на кожен хід, разом. */
  response: string;
  steps: number;
  costUsd: number;
  toolCalls: ToolCallRecord[];
  /** Спроби інструментів, яких немає в allowlist (ім'я, як його назвала модель). */
  unknownTools: string[];
  hitlAsked: number;
  audit: { action: string; decision: string; actor: string }[];
  state: Record<string, { status: string; criteria?: Record<string, unknown>; shortlist: string[] }>;
  /** Довідка для shortlist_quality: ціни, тварини, дублі, здані, «з майбутнього». */
  listingFacts: (key: string) => { priceUah: number; petsAllowed: boolean | null; canonical: string; rented: boolean; future: boolean } | undefined;
  error?: string;
}
