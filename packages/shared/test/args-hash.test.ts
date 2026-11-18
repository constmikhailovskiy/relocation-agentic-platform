import { describe, expect, it } from "vitest";
import { argsHash, viewingArgsHash } from "../src/args-hash.ts";

/**
 * Хеш запиту на перегляд рахують ДВІ сторони: сервер relocation (коли створює запит) і runtime
 * (з того, що показав людині). Якщо правила нормалізації (порядок слотів) розійдуться,
 * кожне чесне підтвердження впаде з args_mismatch. Тому функція одна, у shared.
 */
describe("viewingArgsHash", () => {
  const base = { searchId: "s-olena", listingKey: "olx:1001", slots: ["2026-11-22T15:00:00.000Z", "2026-11-21T10:00:00.000Z"] };

  it("порядок слотів не важить", () => {
    expect(viewingArgsHash({ ...base, slots: [...base.slots].reverse() })).toBe(viewingArgsHash(base));
  });

  it("інша квартира чи інший слот — інший хеш", () => {
    expect(viewingArgsHash({ ...base, listingKey: "olx:1002" })).not.toBe(viewingArgsHash(base));
    expect(viewingArgsHash({ ...base, slots: ["2026-11-23T10:00:00.000Z"] })).not.toBe(viewingArgsHash(base));
  });

  it("дорівнює argsHash від канонічних аргументів (слоти відсортовані)", () => {
    expect(viewingArgsHash(base)).toBe(argsHash({ ...base, slots: [...base.slots].sort() }));
  });

  it("не змінює вхідний масив слотів", () => {
    const slots = [...base.slots];
    viewingArgsHash({ ...base, slots });
    expect(slots).toEqual(base.slots);
  });
});
