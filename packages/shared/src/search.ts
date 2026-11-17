import { z } from "zod";
import { Criteria } from "./criteria.ts";
import { SearchStatus } from "./status.ts";

/** Елемент шортлиста. Ключ — канонічний ключ оголошення з listings (наприклад, "olx:1001"). */
export const ShortlistItem = z.object({
  listingKey: z.string().min(1).max(64),
  reason: z.string().max(500).optional().describe("Чому оголошення підходить — коротко, для людини"),
});
export type ShortlistItem = z.output<typeof ShortlistItem>;

/** Пошук житла одного працівника (рядок таблиці searches). Шортлист зберігається окремо. */
export const Search = z.object({
  id: z.string(),
  employeeId: z.string(),
  status: SearchStatus,
  /** Ліміт компанії на оренду. Бюджет понад нього — лише через request_budget_exception. */
  companyCapUah: z.number().int().positive(),
  /** У статусі draft критеріїв ще може не бути. */
  criteria: Criteria.optional(),
});
export type Search = z.output<typeof Search>;
