import { z } from "zod";

/**
 * Сирі формати джерел. Навмисно різні й «незручні», як у житті:
 * OLX тримає атрибути в масиві params рядками, ЛУН — плоскі поля, поверх як "3/9",
 * ціну або в гривнях, або в доларах. Ці схеми використовують генератор фікстур,
 * адаптери в mcp/listings і тести.
 */

export const OlxParam = z.object({
  key: z.enum(["number_of_rooms", "total_area", "floor", "total_floors", "pets", "available_from", "amenities"]),
  value: z.string().nullable(),
});

export const OlxRaw = z.object({
  id: z.number().int(),
  title: z.string(),
  url: z.url(),
  price: z.object({ value: z.number(), currency: z.enum(["UAH", "USD"]) }),
  params: z.array(OlxParam),
  location: z.object({ city: z.literal("Львів"), district: z.string(), street: z.string() }),
  description: z.string(),
  contact: z.object({ name: z.string(), phone: z.string() }),
  created_time: z.iso.datetime(),
});
export type OlxRaw = z.infer<typeof OlxRaw>;

export const LunRaw = z.object({
  listing_id: z.string(),
  headline: z.string(),
  link: z.url(),
  price_uah: z.number().nullable(),
  price_usd: z.number().nullable(),
  rooms: z.number().int(),
  area: z.number(),
  floor: z.string().regex(/^\d+\/\d+$/),
  district_name: z.string(),
  street: z.string(),
  text: z.string(),
  owner: z.object({ name: z.string(), tel: z.string() }),
  published_at: z.iso.datetime(),
  available_from: z.iso.date(),
  pets_ok: z.boolean().nullable(),
  features: z.array(z.string()),
});
export type LunRaw = z.infer<typeof LunRaw>;
