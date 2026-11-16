import { z } from "zod";

export const Role = z.enum(["new_hire", "relocation_manager", "hiring_manager", "agent_builder", "auditor"]);
export type Role = z.infer<typeof Role>;

export const Employee = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  roles: z.array(Role).min(1),
  managerId: z.string().nullable(),
  startDate: z.iso.date(),
});
export type Employee = z.infer<typeof Employee>;
