import { z } from "zod";
import { District } from "./lviv.ts";
import { Amenity } from "./criteria.ts";

export const Source = z.enum(["olx", "lun"]);
export type Source = z.infer<typeof Source>;

export const Money = z.object({
  amount: z.number().positive(),
  currency: z.enum(["UAH", "USD"]),
});
export type Money = z.infer<typeof Money>;

/**
 * Нормалізоване оголошення — те, з чим працює вся платформа.
 * Сирі формати OLX і ЛУН (див. sources.ts) перетворюються в це адаптерами
 * у MCP-сервері listings. Решта коду про сирі формати нічого не знає.
 */
export const Listing = z.object({
  key: z.string().describe("Глобальний ключ: <source>:<externalId>"),
  source: Source,
  externalId: z.string(),
  url: z.url(),
  title: z.string(),
  price: Money,
  priceUah: z.number().int().positive().describe("Ціна, приведена до гривні"),
  rooms: z.number().int().min(1),
  areaM2: z.number().positive(),
  floor: z.number().int(),
  totalFloors: z.number().int(),
  district: District,
  street: z.string(),
  petsAllowed: z.boolean().nullable().describe("null = в оголошенні не вказано"),
  amenities: z.array(Amenity),
  availableFrom: z.iso.date(),
  postedAt: z.iso.datetime(),
  commuteMin: z.number().int().positive(),
  /** НЕДОВІРЕНИЙ текст від третьої сторони. Модель має сприймати його як дані, не як інструкції. */
  untrustedText: z.string(),
});
export type Listing = z.infer<typeof Listing>;

/**
 * Контакти орендодавця живуть окремо і НЕ входять у Listing:
 * модель їх ніколи не бачить. Їх використовує лише request_viewing після HITL.
 */
export const LandlordContact = z.object({
  listingKey: z.string(),
  name: z.string(),
  phone: z.string(),
});
export type LandlordContact = z.infer<typeof LandlordContact>;

export const listingKey = (source: Source, externalId: string) => `${source}:${externalId}`;
