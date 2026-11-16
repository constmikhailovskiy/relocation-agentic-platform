import { z } from "zod";
import { District } from "./lviv.ts";

export const Amenity = z.enum([
  "balcony",
  "washing_machine",
  "dishwasher",
  "backup_power", // генератор, EcoFlow або автономне опалення — актуально для блекаутів
  "parking",
]);
export type Amenity = z.infer<typeof Amenity>;

/** Як зручності пишуть в оголошеннях. Адаптери джерел мапитимуть ці слова назад в Amenity. */
export const AMENITY_NAMES_UK: Record<Amenity, string> = {
  balcony: "балкон",
  washing_machine: "пральна машина",
  dishwasher: "посудомийка",
  backup_power: "генератор",
  parking: "паркомісце",
};

/**
 * Критерії пошуку житла. Ця сама схема:
 *  - валідує вхід інструмента set_criteria (MCP),
 *  - генерує JSON Schema для моделі (z.toJSONSchema),
 *  - дає TypeScript-тип через z.infer.
 * Тобто одне джерело правди для моделі, сервера і коду.
 */
export const Criteria = z
  .object({
    maxBudgetUah: z.number().int().positive().max(200_000).describe("Максимальна оренда на місяць, грн"),
    minRooms: z.number().int().min(1).max(5).default(1),
    districts: z.array(District).max(6).default([]).describe("Бажані райони; порожньо = будь-який"),
    excludeDistricts: z.array(District).default([]),
    maxCommuteMin: z.number().int().positive().max(120).optional().describe("Максимум хвилин до офісу"),
    pets: z.boolean().default(false).describe("Чи є домашні тварини"),
    moveInBy: z.iso.date().optional().describe("Заселитися не пізніше, YYYY-MM-DD"),
    mustHave: z.array(Amenity).default([]),
  })
  .refine((c) => !c.districts.some((d) => c.excludeDistricts.includes(d)), {
    message: "Район не може бути одночасно бажаним і виключеним",
    path: ["excludeDistricts"],
  });

/** Тип ПІСЛЯ парсингу: дефолти вже підставлені. */
export type Criteria = z.output<typeof Criteria>;
/** Тип ДО парсингу: те, що може прислати модель або UI. */
export type CriteriaInput = z.input<typeof Criteria>;
