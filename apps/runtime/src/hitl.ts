import { viewingArgsHash } from "@reloc/shared";
import { z } from "zod";
import type { Guard } from "./loop.ts";
import type { ToolResult } from "./tools.ts";

/**
 * Інструменти з високим ризиком — ТАБЛИЦЯ В RUNTIME, а не поле в специфікації агента чи анотація сервера.
 * No-code builder (етап 8) редагує специфікацію; якби ризик жив там, HITL можна було б «вимкнути» формою.
 * Новий інструмент з ризиком = новий рядок тут + свій guard; без guard запуск не стартує (див. chat.ts).
 */
export const HIGH_RISK_TOOLS: readonly string[] = ["relocation.request_viewing"];

/** Що саме показуємо людині. З цього ж обʼєкта рахується хеш для підтвердження. */
export interface ViewingShown {
  searchId: string;
  listingKey: string;
  slots: string[];
}

export type ConfirmResult = { ok: true; data: unknown } | { ok: false; code: string; message: string };
export type ConfirmFn = (approvalId: string, argsHash: string) => Promise<ConfirmResult>;

export interface ViewingGuardDeps {
  /** Показати людині запит і отримати так/ні. EOF, Ctrl+D, порожня відповідь — «ні». */
  ask: (shown: ViewingShown) => Promise<boolean>;
  /** Підтвердити запит на сервері від імені людини (без act). */
  confirm: ConfirmFn;
}

/** Аргументи request_viewing так, як їх надсилає модель. Лише форма — зміст перевірить сервер. */
const ViewingArgs = z.object({ search_id: z.string(), listing_key: z.string(), slots: z.array(z.string()).min(1) });

const fail = (code: string, message: string): ToolResult => ({ isError: true, text: JSON.stringify({ error: { code, message, retryable: false } }) });

/**
 * HITL для request_viewing. Порядок важливий:
 *  1. Показати людині аргументи, які ПІДУТЬ на сервер (а не текст моделі про них).
 *  2. «Ні» → інструмент не викликається взагалі.
 *  3. «Так» → request_viewing створює pending-запит.
 *  4. Підтвердити його хешем ПОКАЗАНОГО (viewingArgsHash(shown)), а не argsHash з відповіді сервера:
 *     хеш з відповіді завжди збігся б сам із собою і нічого б не захищав.
 */
export function viewingGuard(deps: ViewingGuardDeps): Guard {
  return async (args, exec) => {
    const parsed = ViewingArgs.safeParse(args);
    // Аргументи не того вигляду: людину не смикаємо, сервер поверне моделі invalid_input з підказкою.
    if (!parsed.success) return exec();

    const shown: ViewingShown = { searchId: parsed.data.search_id, listingKey: parsed.data.listing_key, slots: parsed.data.slots };
    if (!(await deps.ask(shown))) {
      return fail("rejected_by_user", "Користувач не підтвердив перегляд. Орендодавцю нічого не надіслано. Не повторюй запит, доки користувач сам не попросить.");
    }

    const created = await exec();
    if (created.isError) return created;
    const { approvalId } = JSON.parse(created.text) as { approvalId: string };

    const confirmed = await deps.confirm(approvalId, viewingArgsHash(shown));
    if (!confirmed.ok) return fail(confirmed.code, `Запит ${approvalId} створено, але підтвердження не пройшло: ${confirmed.message}`);
    return { isError: false, text: JSON.stringify(confirmed.data) };
  };
}
