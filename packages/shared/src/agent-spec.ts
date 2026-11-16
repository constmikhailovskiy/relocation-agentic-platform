import { z } from "zod";
import { Role } from "./people.ts";

/** "<server>.<tool>", наприклад "relocation.request_viewing". */
export const ToolRef = z.string().regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/, "Формат: server.tool");

/**
 * Специфікація агента — те, що редагує no-code builder і що лежить у agents/*.yaml.
 * Агент = дані, а не код. Тому його можна версіонувати, порівнювати (diff),
 * валідувати і проганяти через eval-гейт перед публікацією.
 */
export const AgentSpec = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.number().int().positive(),
  owner: z.email(),
  description: z.string().min(10),
  model: z.object({
    primary: z.string(),
    fallback: z.string().optional(),
  }),
  dataClass: z.enum(["internal", "restricted"]).describe("restricted → лише локальні моделі"),
  instructions: z.string().min(20),
  skills: z.array(z.string()).default([]),
  tools: z.array(ToolRef).min(1),
  limits: z.object({
    maxSteps: z.number().int().min(1).max(50),
    maxCostUsdPerRun: z.number().positive().max(5),
    dailyBudgetUsd: z.number().positive().max(100),
  }),
  audience: z.object({ roles: z.array(Role).min(1) }),
  evals: z.object({
    suite: z.string(),
    minPassRate: z.number().min(0).max(1),
    securityMustPass: z.literal(true), // вимкнути security-гейт неможливо навіть через no-code
  }),
});
export type AgentSpec = z.output<typeof AgentSpec>;
