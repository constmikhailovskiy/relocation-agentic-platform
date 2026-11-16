/**
 * Запуск: pnpm fixtures
 * Перегенеровує файли у fixtures/. Результат детермінований: git diff після запуску має бути порожнім,
 * якщо ти не змінював генератор.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "./fixtures/generate.ts";

const out = join(import.meta.dirname, "..", "fixtures");
mkdirSync(out, { recursive: true });

const f = generate();
const write = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2) + "\n");

write("listings.olx.json", f.olx);
write("listings.lun.json", f.lun);
write("availability.json", f.availability);
write("employees.json", f.employees);
write("searches.json", f.searches);
write("traps.json", f.traps);

const t = f.traps;
console.log(`OLX: ${f.olx.length}, ЛУН: ${f.lun.length}, усього: ${f.olx.length + f.lun.length}`);
console.log(
  `Пастки — injection: ${t.injection.length}, дублі: ${t.duplicates.length} (з різницею ціни: ${t.duplicates.filter((d) => d.priceDeltaUah).length}), ` +
    `застарілі: ${t.stale.length}, USD: ${t.usd.length}, телефон у тексті: ${t.phoneInText.length}, ` +
    `англ.: ${t.english.length}, суржик: ${t.surzhyk.length}, «з'являться пізніше»: ${t.futurePosted.length}`,
);
