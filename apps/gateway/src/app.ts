import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { ClientConfig, Config } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import { ChatRequest, type ChatChunk, type ChatResponse, type FinishReason, type Usage, toOpenAIUsage } from "./openai-types.ts";
import { PolicyError, authenticate, authorizeModel, checkPromptSize, type DataClass, redactMessages } from "./policy.ts";
import type { Provider, StreamEvent } from "./providers/types.ts";
import { type ModelEntry, type ProviderName, type Registry, costUsd } from "./registry.ts";
import { CircuitBreaker, HttpError, isRetryable, upstreamSignal, withRetry } from "./reliability.ts";

export interface Deps {
  config: Pick<Config, "GATEWAY_CLIENTS" | "ALLOWED_MODEL_ORIGINS" | "FAIL_PROVIDER" | "UPSTREAM_TIMEOUT_MS">;
  registry: Registry;
  providers: Record<ProviderName, Provider>;
  ledger: Ledger;
  /** Для тестів: вимкнути паузи між ретраями. */
  retry?: { retries?: number; baseMs?: number };
}

type Vars = { Variables: { client: ClientConfig; requestId: string } };

const DataClassHeader = z.enum(["internal", "restricted"]).default("internal");

export function createApp(deps: Deps) {
  const { registry, providers, ledger, config } = deps;
  const breakers = Object.fromEntries(
    (Object.keys(providers) as ProviderName[]).map((p) => [p, new CircuitBreaker(p)]),
  ) as Record<ProviderName, CircuitBreaker>;

  const app = new Hono<Vars>();

  // ---------- Наскрізне: request id, автентифікація, помилки ----------

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });

  app.use("/v1/*", async (c, next) => {
    c.set("client", authenticate(c.req.header("authorization"), config.GATEWAY_CLIENTS));
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof PolicyError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof HttpError) {
      const status = err.status === 429 ? 429 : 502;
      // Для on-call: невдалі виклики теж мають бути видно в логах, а не лише успішні.
      console.warn(JSON.stringify({ level: "warn", requestId: c.get("requestId"), upstreamStatus: err.status, error: err.message }));
      return c.json({ error: { code: "upstream_error", message: err.message } }, status);
    }
    console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), error: String(err) }));
    return c.json({ error: { code: "internal", message: "Внутрішня помилка gateway" } }, 500);
  });

  // ---------- Службові ендпоінти ----------

  app.get("/healthz", (c) =>
    c.json({ ok: true, breakers: Object.fromEntries(Object.entries(breakers).map(([k, b]) => [k, b.state])) }),
  );

  app.get("/v1/models", (c) => {
    const client = c.get("client");
    const data = registry
      .all()
      .filter((m) => client.models.includes(m.alias))
      .map((m) => ({ id: m.alias, object: "model", owned_by: m.vendor, origin: m.origin, license: m.license, local: m.local }));
    return c.json({ object: "list", data });
  });

  app.get("/v1/usage", (c) => {
    const client = c.get("client");
    return c.json({
      client: client.name,
      spentTodayUsd: ledger.spentTodayUsd(client.name),
      dailyBudgetUsd: client.dailyBudgetUsd,
      recent: ledger.recent(client.name, 10),
    });
  });

  /**
   * Витрати одного запуску агента. Клієнт бачить ЛИШЕ свої запуски.
   * Для чужого або неіснуючого run_id відповідаємо однаково — 404, щоб не підказувати,
   * що такий запуск існує в когось іншого.
   */
  app.get("/v1/usage/runs/:runId", (c) => {
    const client = c.get("client");
    const runId = c.req.param("runId");
    const summary = ledger.runSummary(client.name, runId);
    if (summary.calls === 0) throw new PolicyError(404, "run_not_found", `Запуск ${runId} не знайдено`);
    return c.json({ runId, ...summary, maxRunUsd: client.maxRunUsd });
  });

  // ---------- Головний ендпоінт ----------

  app.post("/v1/chat/completions", async (c) => {
    const started = Date.now();
    const client = c.get("client");
    const requestId = c.get("requestId");

    // 1. Валідація запиту: те саме, що для інструментів агента — недовірений вхід.
    const parsed = ChatRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new PolicyError(400, "invalid_request", z.prettifyError(parsed.error));
    const req = parsed.data;

    const dataClass: DataClass = DataClassHeader.parse(c.req.header("x-data-class") ?? undefined);
    const runId = c.req.header("x-run-id") ?? null;
    const agentId = c.req.header("x-agent-id") ?? null;

    // 2. Політики для основної моделі: доступ, походження, клас даних, розмір, бюджет.
    const primary = authorizeModel(client, registry.get(req.model), req.model, { allowedOrigins: config.ALLOWED_MODEL_ORIGINS, dataClass });
    const estTokens = checkPromptSize(req, primary);
    const estCost = costUsd(primary, { inputTokens: estTokens, outputTokens: req.max_tokens ?? 1024, cacheReadTokens: 0, cacheWriteTokens: 0 });
    if (ledger.spentTodayUsd(client.name) + estCost > client.dailyBudgetUsd) {
      throw new PolicyError(429, "daily_budget_exceeded", `Денний бюджет клієнта ${client.name} ($${client.dailyBudgetUsd}) вичерпано`);
    }
    if (runId && ledger.spentOnRunUsd(client.name, runId) + estCost > client.maxRunUsd) {
      throw new PolicyError(429, "run_budget_exceeded", `Бюджет запуску ${runId} ($${client.maxRunUsd}) вичерпано`);
    }

    // 3. Ланцюжок кандидатів: основна модель + fallback-и, що проходять ті самі політики.
    const chain: ModelEntry[] = [primary];
    for (let next = primary.fallback; next && chain.length < 3; ) {
      const entry = registry.get(next);
      try {
        chain.push(authorizeModel(client, entry, next, { allowedOrigins: config.ALLOWED_MODEL_ORIGINS, dataClass }));
      } catch {
        /* fallback, недоступний цьому клієнту чи класу даних, просто пропускаємо */
      }
      next = entry?.fallback;
    }

    const upstreamFor = (entry: ModelEntry) => {
      // PII редагуємо лише для хмарних моделей: локальні не виносять даних назовні.
      const { messages, redactions } = entry.local ? { messages: req.messages, redactions: 0 } : redactMessages(req.messages);
      return { body: { ...req, model: entry.upstreamModel, messages } as ChatRequest, redactions };
    };

    const callGuard = (entry: ModelEntry) => {
      breakers[entry.provider].assertCanCall();
      if (config.FAIL_PROVIDER && (config.FAIL_PROVIDER === entry.provider || config.FAIL_PROVIDER === entry.alias)) {
        throw new HttpError(503, `chaos: ${config.FAIL_PROVIDER} вимкнено через FAIL_PROVIDER`);
      }
    };

    const record = (entry: ModelEntry, usage: Usage, status: "ok" | "error" | "partial", redactions: number) => {
      const cost = costUsd(entry, usage);
      ledger.record({
        ts: new Date().toISOString(),
        requestId,
        client: client.name,
        runId,
        agentId,
        modelAlias: entry.alias,
        provider: entry.provider,
        ...usage,
        costUsd: cost,
        latencyMs: Date.now() - started,
        status,
        fallbackFrom: entry === primary ? null : primary.alias,
        redactions,
      });
      console.log(JSON.stringify({ level: "info", requestId, client: client.name, runId, requested: primary.alias, used: entry.alias, status, costUsd: cost, latencyMs: Date.now() - started, redactions }));
      return cost;
    };

    const retryOpts = { retries: deps.retry?.retries ?? 2, baseMs: deps.retry?.baseMs ?? 300 };
    const signal = upstreamSignal(c.req.raw.signal, config.UPSTREAM_TIMEOUT_MS);
    let lastError: unknown;
    // Історія спроб: якщо впадуть усі кандидати, on-call має бачити ВСЮ картину,
    // а не лише останню помилку («ollama недоступний» приховав би, що haiku теж лежить).
    const attempts: string[] = [];
    const allFailed = () =>
      new HttpError(lastError instanceof HttpError ? lastError.status : 502, `Усі моделі недоступні — ${attempts.join("; ")}`);

    // 4а. Без стріму: пробуємо кандидатів по черзі.
    if (!req.stream) {
      for (const entry of chain) {
        const { body, redactions } = upstreamFor(entry);
        try {
          const result = await withRetry(async () => {
            callGuard(entry);
            return providers[entry.provider].complete(body, signal);
          }, { ...retryOpts, signal });
          breakers[entry.provider].success();
          const cost = record(entry, result.usage, "ok", redactions);
          const response: ChatResponse = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: entry.alias,
            choices: [{ index: 0, message: result.message, finish_reason: result.finishReason }],
            usage: toOpenAIUsage(result.usage),
          };
          c.header("x-gateway-model", entry.alias);
          c.header("x-gateway-cost-usd", cost.toFixed(6));
          if (entry !== primary) c.header("x-gateway-fallback-from", primary.alias);
          return c.json(response);
        } catch (e) {
          lastError = e;
          if (!isRetryable(e)) throw e; // 400 від провайдера fallback не виправить
          attempts.push(`${entry.alias}: ${(e as Error).message}`);
          breakers[entry.provider].failure();
        }
      }
      throw allFailed();
    }

    // 4б. Стрім. Fallback можливий лише ДО першого байта клієнту:
    //     чекаємо першу подію від провайдера, і тільки потім «комітимось» на відповідь.
    for (const entry of chain) {
      const { body, redactions } = upstreamFor(entry);
      let opened: { gen: AsyncGenerator<StreamEvent>; first: IteratorResult<StreamEvent> };
      try {
        opened = await withRetry(async () => {
          callGuard(entry);
          const gen = providers[entry.provider].stream(body, signal);
          return { gen, first: await gen.next() };
        }, { ...retryOpts, signal });
      } catch (e) {
        lastError = e;
        if (!isRetryable(e)) throw e;
        attempts.push(`${entry.alias}: ${(e as Error).message}`);
        breakers[entry.provider].failure();
        continue;
      }
      breakers[entry.provider].success();
      c.header("x-gateway-model", entry.alias);
      if (entry !== primary) c.header("x-gateway-fallback-from", primary.alias);

      return streamSSE(c, async (sse) => {
        const id = `chatcmpl-${requestId}`;
        const created = Math.floor(Date.now() / 1000);
        const chunk = (delta: ChatChunk["choices"][number]["delta"], finish: FinishReason | null = null): ChatChunk => ({
          id, object: "chat.completion.chunk", created, model: entry.alias, choices: [{ index: 0, delta, finish_reason: finish }],
        });
        let usage: Usage | undefined;
        let partialChars = 0;
        let status: "ok" | "partial" = "partial";

        await sse.writeSSE({ data: JSON.stringify(chunk({ role: "assistant" })) });
        try {
          for (let it = opened.first; !it.done; it = await opened.gen.next()) {
            const ev = it.value;
            if (ev.type === "usage") usage = ev.usage;
            else if (ev.type === "finish") await sse.writeSSE({ data: JSON.stringify(chunk({}, ev.finishReason)) });
            else if (ev.delta.reasoning !== undefined) {
              // Міркування — це теж вихідні токени: рахуємо їх для бюджету, якщо usage не прийде.
              partialChars += ev.delta.reasoning.length;
              await sse.writeSSE({ data: JSON.stringify(chunk({ reasoning: ev.delta.reasoning })) });
            } else if (ev.delta.content !== undefined) {
              partialChars += ev.delta.content.length;
              await sse.writeSSE({ data: JSON.stringify(chunk({ content: ev.delta.content })) });
            } else if (ev.delta.toolCall) {
              const t = ev.delta.toolCall;
              partialChars += t.argumentsDelta.length;
              await sse.writeSSE({
                data: JSON.stringify(chunk({
                  tool_calls: [{ index: t.index, ...(t.id ? { id: t.id, type: "function" as const } : {}), function: { ...(t.name ? { name: t.name } : {}), arguments: t.argumentsDelta } }],
                })),
              });
            }
          }
          status = "ok";
          if (req.stream_options?.include_usage && usage) {
            await sse.writeSSE({ data: JSON.stringify({ id, object: "chat.completion.chunk", created, model: entry.alias, choices: [], usage: toOpenAIUsage(usage) }) });
          }
          await sse.writeSSE({ data: "[DONE]" });
        } catch (e) {
          // Після першого байта перемкнутися на іншу модель уже не можна — повідомляємо клієнта.
          await sse.writeSSE({ data: JSON.stringify({ error: { code: "upstream_error", message: String((e as Error).message) } }) }).catch(() => {});
        } finally {
          // Клієнт відключився або стрім обірвався — витрати все одно рахуємо, інакше бюджет «тече».
          record(entry, usage ?? { inputTokens: estTokens, outputTokens: Math.ceil(partialChars / 3), cacheReadTokens: 0, cacheWriteTokens: 0 }, status, redactions);
        }
      });
    }
    throw allFailed();
  });

  return app;
}
