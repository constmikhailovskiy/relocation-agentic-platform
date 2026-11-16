/**
 * Генерує новий ключ клієнта gateway.
 * Запуск: pnpm gateway:key evals
 * Ключ показуємо один раз; у конфіг іде лише його sha256.
 */
import { createHash, randomBytes } from "node:crypto";

const name = process.argv[2] ?? "client";
const key = `gw_${name}_${randomBytes(24).toString("base64url")}`;
const keySha256 = createHash("sha256").update(key).digest("hex");

console.log(`Ключ (збережи, більше не покажемо): ${key}`);
console.log("Додай у GATEWAY_CLIENTS:");
console.log(JSON.stringify({ name, keySha256, models: ["haiku"], dailyBudgetUsd: 1, maxRunUsd: 0.1 }));
