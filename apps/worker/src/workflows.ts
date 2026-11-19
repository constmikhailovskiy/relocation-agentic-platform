/**
 * Workflow-код виконується в ПІСОЧНИЦІ Temporal і має бути детермінованим: при відновленні (replay) воркер
 * проганяє його знову по історії подій. Тому тут:
 *  - лише @temporalio/workflow і `import type` (значення з @reloc/shared потягли б node:sqlite у бандл);
 *  - жодних Date.now(), Math.random(), мережі — усе це в activities;
 *  - інтервал і таймаути — з input, а не з env.
 */
import { ActivityFailure, ApplicationFailure, condition, continueAsNew, defineQuery, defineSignal, log, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type { ScoutActivities } from "./activities.ts";

/**
 * Тривалість у форматі Temporal ("5 minutes", "30s"). Окремо пакет workflow цей тип не експортує, тож беремо
 * його з сигнатури proxyActivities: `Parameters<F>[0]` — тип першого аргументу функції.
 */
export type Duration = NonNullable<Parameters<typeof proxyActivities>[0]["startToCloseTimeout"]>;

/** Таймаути activity — з input workflow (у тестах коротші, ніж у проді). */
export interface ActivityTimeouts {
  startToClose?: Duration;
  heartbeat?: Duration;
  retryInitial?: Duration;
}

export const criteriaUpdated = defineSignal("criteriaUpdated");
export const setPaused = defineSignal<[boolean]>("setPaused");
export const closeSearch = defineSignal<["secured" | "cancelled"]>("closeSearch");

export interface SearchStatus {
  iteration: number;
  emptyDays: number;
  paused: boolean;
  failedRuns: number;
  /** Чому пауза поставлена самим workflow (напр. grant_missing). Ручна пауза сигналом — без причини. */
  pausedReason?: string;
  lastRunKey?: string;
  last?: { newItems: number; added: string[]; notified: boolean };
}
export const statusQuery = defineQuery<SearchStatus>("status");

export interface SearchWorkflowInput {
  searchId: string;
  employeeId: string;
  /** Пауза між запусками Scout: "24 hours" у проді, "2 minutes" у демо. */
  tick: Duration;
  timeouts?: ActivityTimeouts;
  /** Для демо й тестів: завершитися після N ітерацій, щоб workflow не палив гроші вічно. */
  maxIterations?: number;
  // Стан, що переживає continueAsNew:
  criteriaReady?: boolean;
  emptyDays?: number;
  iteration?: number;
  paused?: boolean;
  failedRuns?: number;
  pausedReason?: string;
}

export async function searchWorkflow(input: SearchWorkflowInput): Promise<string> {
  const t = input.timeouts ?? {};
  const acts = proxyActivities<ScoutActivities>({
    startToCloseTimeout: t.startToClose ?? "5 minutes",
    // Серцебиття: смерть воркера видно за heartbeatTimeout, а не через 5 хвилин startToClose.
    heartbeatTimeout: t.heartbeat ?? "30 seconds",
    retry: { initialInterval: t.retryInitial ?? "10 seconds", backoffCoefficient: 2, maximumAttempts: 5 },
  });

  let criteriaReady = input.criteriaReady ?? true;
  let emptyDays = input.emptyDays ?? 0;
  let iteration = input.iteration ?? 0;
  let paused = input.paused ?? false;
  let failedRuns = input.failedRuns ?? 0;
  let pausedReason = input.pausedReason;
  let lastRunKey: string | undefined;
  let last: SearchStatus["last"];
  // Ідентифікатор ПЕРШОГО запуску цього workflow: однаковий для ретраїв і continueAsNew, різний для кожного старту.
  const startId = workflowInfo().firstExecutionRunId;
  let closed: "secured" | "cancelled" | undefined;

  setHandler(criteriaUpdated, () => {
    criteriaReady = true;
    emptyDays = 0;
  });
  setHandler(setPaused, (p) => {
    paused = p;
    if (!p) pausedReason = undefined;
  });
  setHandler(closeSearch, (reason) => {
    closed = reason;
  });
  setHandler(statusQuery, () => ({
    iteration, emptyDays, paused, failedRuns,
    ...(pausedReason && { pausedReason }), ...(lastRunKey && { lastRunKey }), ...(last && { last }),
  }));

  /** Остаточний провал activity (ретраї вичерпано або nonRetryable). Тип помилки — з ApplicationFailure. */
  const failureType = (e: unknown) => (e instanceof ActivityFailure && e.cause instanceof ApplicationFailure ? e.cause.type : undefined);

  await condition(() => criteriaReady || closed !== undefined);

  while (!closed) {
    if (!paused) {
      // runKey — ідемпотентність усередині ітерації: повтори activity мають той самий ключ, наступний день
      // і НАСТУПНИЙ СТАРТ workflow — інший (startId), інакше новий старт «з'їв» би лист через старий ключ.
      const runKey = `${input.searchId}:${startId}:${iteration}`;
      lastRunKey = runKey;
      const base = { searchId: input.searchId, employeeId: input.employeeId, runKey };
      try {
        const before = await acts.snapshotShortlist(base);
        last = await acts.runScout({ ...base, before });
        emptyDays = last.newItems === 0 ? emptyDays + 1 : 0;
        if (emptyDays === 3) await acts.markNeedsAttention({ ...base, reason: "3 дні без нових варіантів" });
      } catch (e) {
        // Запуск не вдався навіть після ретраїв (бюджет, ліміт кроків, сервіси лежать) — це не «порожній день»,
        // і workflow від цього не помирає: наступна спроба — завтра.
        failedRuns++;
        log.warn("ітерація Scout не вдалась", { runKey, error: String(e) });
        if (failureType(e) === "grant_missing") {
          // Людина відкликала дозвіл: без нового гранту продовжувати немає сенсу — пауза до сигналу resume.
          paused = true;
          pausedReason = "grant_missing";
        }
      }
      iteration++;
      if (input.maxIterations !== undefined && iteration >= input.maxIterations) return "max_iterations";
      if (iteration % 50 === 0) {
        // Історія подій не росте безкінечно. Увесь стан — у новий запуск (у каркасі з case.md губився paused).
        await continueAsNew<typeof searchWorkflow>({ ...input, criteriaReady, emptyDays, iteration, paused, failedRuns, ...(pausedReason && { pausedReason }) });
      }
    }
    // На паузі ітерації не рахуються: інакше пауза «з'їдала» б maxIterations.
    await condition(() => closed !== undefined, input.tick);
  }
  return closed;
}
