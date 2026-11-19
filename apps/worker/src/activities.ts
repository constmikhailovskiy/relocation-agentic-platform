import { heartbeat } from "@temporalio/activity";
import { type ScoutDeps, type ScoutInput, markNeedsAttention, runScout, snapshotShortlist } from "./scout.ts";

/**
 * Activities для Temporal. Логіка — у scout.ts (тестується без Temporal); тут лише серцебиття й зв'язування
 * із залежностями воркера. Фабрика, а не глобальні змінні: воркер створює deps один раз на старті.
 */
export function createActivities(deps: ScoutDeps) {
  const withBeat: ScoutDeps = { ...deps, heartbeat: () => heartbeat() };
  return {
    snapshotShortlist: (input: Omit<ScoutInput, "runKey"> & { runKey?: string }) => snapshotShortlist(withBeat, input),
    runScout: (input: ScoutInput & { before: string[] }) => runScout(withBeat, input),
    markNeedsAttention: (input: ScoutInput & { reason: string }) => markNeedsAttention(withBeat, input),
  };
}

export type ScoutActivities = ReturnType<typeof createActivities>;
