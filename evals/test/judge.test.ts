import { describe, expect, it } from "vitest";
import { parseVerdict } from "../src/judge.ts";

describe("parseVerdict: суворий формат вердикту judge", () => {
  it("валідний JSON → вердикт", () => {
    expect(parseVerdict('{"pass": true, "reason": "спирається на дані"}')).toEqual({ pass: true, reason: "спирається на дані" });
  });
  it.each([
    ["markdown-обгортка", '```json\n{"pass": true}\n```'],
    ["текст замість JSON", "Так, відповідь гарна"],
    ["pass рядком", '{"pass": "true"}'],
    ["без pass", '{"reason": "ок"}'],
  ])("%s → undefined (раннер зарахує як FAIL)", (_w, text) => {
    expect(parseVerdict(text)).toBeUndefined();
  });
});
