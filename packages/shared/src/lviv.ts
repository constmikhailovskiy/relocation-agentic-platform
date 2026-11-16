import { z } from "zod";

/**
 * Довідник Львова для кейсу. Канонічні ключі латиницею — їх бачать код, БД і модель;
 * українські назви — лише для людей і для парсингу сирих оголошень.
 */
export const District = z.enum([
  "halytskyi",
  "zaliznychnyi",
  "lychakivskyi",
  "sykhivskyi",
  "frankivskyi",
  "shevchenkivskyi",
]);
export type District = z.infer<typeof District>;

export const DISTRICT_NAMES_UK: Record<District, string> = {
  halytskyi: "Галицький",
  zaliznychnyi: "Залізничний",
  lychakivskyi: "Личаківський",
  sykhivskyi: "Сихівський",
  frankivskyi: "Франківський",
  shevchenkivskyi: "Шевченківський",
};

/** Зворотний пошук: «Франківський район» / «Франківський» → frankivskyi. */
export function districtFromUk(raw: string): District | undefined {
  const needle = raw.toLowerCase().replace(/\s*район\s*/u, "").trim();
  for (const [key, name] of Object.entries(DISTRICT_NAMES_UK)) {
    if (name.toLowerCase() === needle) return key as District;
  }
  return undefined;
}

/**
 * Умовний час дороги до офісу громадським транспортом, хвилини.
 * Це припущення кейсу, а не реальні дані: так ми не залежимо від зовнішніх карт,
 * а evals лишаються детермінованими.
 */
export const COMMUTE_MIN: Record<District, number> = {
  halytskyi: 15,
  frankivskyi: 20,
  shevchenkivskyi: 25,
  lychakivskyi: 25,
  zaliznychnyi: 30,
  sykhivskyi: 40,
};

/** Фіксований курс для фікстур і нормалізації цін. Детермінованість важливіша за точність. */
export const FX_USD_UAH = 42;
