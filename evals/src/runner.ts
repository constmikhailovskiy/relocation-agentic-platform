import type { AgentSpec } from "@reloc/shared";
import { viewingGuard } from "../../apps/runtime/src/hitl.ts";
import type { TraceEvent } from "../../apps/runtime/src/loop.ts";
import { connectTools } from "../../apps/runtime/src/mcp-tools.ts";
import type { CallModel } from "../../apps/runtime/src/model.ts";
import { relocationConfirmer } from "../../apps/runtime/src/relocation-client.ts";
import { createSession, delegationHeaders } from "../../apps/runtime/src/session.ts";
import type { ToolHandle, ToolSet } from "../../apps/runtime/src/tools.ts";
import type { EvalCase, RunRecord, ToolCallRecord } from "./case.ts";
import { EVAL_NOW, evalWorld } from "./world.ts";

/** Код помилки з тексту результату інструмента (той самий формат, що в серверів і runtime). */
function errorCode(text: string): string {
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "error";
  } catch {
    return "error";
  }
}

/** Обгортка ToolSet: записує кожен справжній виклик (після guard) — що, з якими аргументами, чим закінчилось. */
function recording(tools: ToolSet, calls: ToolCallRecord[]): ToolSet {
  const wrap = (h: ToolHandle): ToolHandle => ({
    ...h,
    call: async (args, meta) => {
      const r = await h.call(args, meta);
      calls.push({ ref: h.ref, args, ok: !r.isError, text: r.text, ...(r.isError && { error: errorCode(r.text) }) });
      return r;
    },
  });
  const cache = new Map<string, ToolHandle>();
  return {
    defs: tools.defs,
    get: (name) => {
      const h = tools.get(name);
      if (!h) return undefined;
      if (!cache.has(name)) cache.set(name, wrap(h));
      return cache.get(name);
    },
    close: tools.close,
  };
}

/**
 * Один прогін кейсу: свіжий світ → setup → сесія агента від імені as_user → усі ходи input → знімок стану.
 * Модель — ін'єкцією: справжня через gateway або сценарна в офлайн-тестах.
 */
export async function runCase(c: EvalCase, spec: AgentSpec, model: CallModel): Promise<RunRecord> {
  const world = evalWorld(c.setup?.extra_listings ? { extraListings: c.setup.extra_listings } : {});
  for (const s of c.setup?.shortlist ?? []) world.store.addShortlistItems(s.search_id, s.keys.map((listingKey) => ({ listingKey })));
  for (const s of c.setup?.status ?? []) world.store.setStatus(s.search_id, s.status);

  const calls: ToolCallRecord[] = [];
  const unknownTools: string[] = [];
  let hitlAsked = 0;
  const record: RunRecord = {
    caseId: c.id, outcome: "answer", response: "", steps: 0, costUsd: 0, toolCalls: calls, unknownTools, hitlAsked: 0,
    audit: [], state: {}, listingFacts: world.listingFacts,
  };

  let tools: ToolSet | undefined;
  try {
    tools = await connectTools({ servers: world.urls, allowlist: spec.tools, authHeaders: async () => delegationHeaders(c.as_user, spec), fetch: world.fetch });
    const guards = new Map([
      ["relocation.request_viewing", viewingGuard({
        ask: async () => {
          hitlAsked++;
          return c.hitl === "approve";
        },
        confirm: relocationConfirmer({ baseUrl: world.relocationBaseUrl, authHeaders: async () => ({ "x-debug-sub": c.as_user }), fetch: world.fetch }),
      })],
    ]);
    const onTrace = (e: TraceEvent) => {
      if (e.type === "tool" && e.error === "unknown_tool") unknownTools.push(e.tool);
    };
    const session = createSession({ spec, sub: c.as_user, now: EVAL_NOW, model, tools: recording(tools, calls), guards, onTrace });
    const turns: string[] = [];
    for (const input of typeof c.input === "string" ? [c.input] : c.input) {
      const out = await session.send(input);
      record.steps += out.steps;
      record.costUsd += out.costUsd;
      if (out.kind === "answer") turns.push(out.text);
      else {
        record.outcome = out.kind;
        break;
      }
    }
    record.response = turns.join("\n\n");
  } catch (e) {
    record.outcome = "error";
    record.error = e instanceof Error ? e.message : String(e);
  } finally {
    await tools?.close();
  }

  record.hitlAsked = hitlAsked;
  record.audit = world.audit.map((e) => ({ action: e.action, decision: e.decision, actor: e.actor }));
  for (const id of ["s-olena", "s-maksym"]) {
    const s = world.store.searchById(id);
    if (s) record.state[id] = { status: s.status, ...(s.criteria && { criteria: s.criteria as Record<string, unknown> }), shortlist: world.store.shortlist(id).map((i) => i.listingKey) };
  }
  return record;
}
