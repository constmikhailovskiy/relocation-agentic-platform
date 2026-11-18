import { randomUUID } from "node:crypto";
import type { AgentSpec } from "@reloc/shared";
import { type Guard, type RunOutcome, type TraceEvent, runTurn } from "./loop.ts";
import type { Message } from "./messages.ts";
import type { CallModel } from "./model.ts";
import { assertGuarded, systemPrompt } from "./spec.ts";
import type { ToolSet } from "./tools.ts";

/**
 * Делегування для MCP-серверів: sub — людина, act — агент із версією.
 * Етап 2–3: заголовки-заглушки. Етап 4: runtime як STS підписує короткий JWT із тими самими sub/act.
 */
export function delegationHeaders(sub: string, spec: AgentSpec): Record<string, string> {
  return { "x-debug-sub": sub, "x-debug-act": `agent:${spec.id}@${spec.version}` };
}

export interface SessionDeps {
  spec: AgentSpec;
  /** Користувач, від імені якого працює агент. */
  sub: string;
  /** «Зараз» для системного промпту (ISO). У демо — той самий, що в серверів (*_NOW). */
  now: string;
  model: CallModel;
  tools: ToolSet;
  guards: Map<string, Guard>;
  newRunId?: () => string;
  onTrace?: (e: TraceEvent) => void;
}

/**
 * Сесія чату: системний промпт + історія, що живе між ходами. Кожен хід — окремий запуск (свій runId,
 * свій бюджет і ліміт кроків). Без guard для інструмента з високим ризиком сесія не створюється.
 */
export function createSession(deps: SessionDeps): { history: Message[]; send: (text: string) => Promise<RunOutcome> } {
  const { spec, guards, newRunId = randomUUID } = deps;
  assertGuarded(spec.tools, guards);
  const history: Message[] = [{ role: "system", content: systemPrompt(spec, { sub: deps.sub, now: deps.now }) }];
  return {
    history,
    send: (text) =>
      runTurn(history, text, {
        model: deps.model,
        tools: deps.tools,
        limits: spec.limits,
        runId: newRunId(),
        guards,
        ...(deps.onTrace && { onTrace: deps.onTrace }),
      }),
  };
}
