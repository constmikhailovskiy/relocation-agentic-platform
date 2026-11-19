import { defineConfig } from "vitest/config";

/**
 * Тести, яким потрібен справжній сервер Temporal (dev-сервер з @temporalio/testing).
 * Окремо від `pnpm test`: той лишається офлайн. Запуск: pnpm test:temporal.
 */
export default defineConfig({
  test: {
    include: ["apps/worker/temporal-test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
