/**
 * Надійність викликів до провайдерів: класифікація помилок, ретраї з backoff,
 * circuit breaker. Кожен механізм — окремий маленький шматок, щоб його було легко тестувати.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Ретраїмо лише те, що може пройти з другої спроби: перевантаження і збої сервера. 400/401/403 — ні. */
export const isRetryable = (e: unknown) => e instanceof HttpError && (e.status === 429 || e.status >= 500);

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries?: number; baseMs?: number; maxMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const { retries = 2, baseMs = 300, maxMs = 5_000, signal } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      // Full jitter: випадкова затримка від 0 до експоненти, щоб клієнти не ретраїли синхронно.
      const backoff = Math.random() * Math.min(maxMs, baseMs * 2 ** attempt);
      const hinted = e instanceof HttpError ? e.retryAfterMs : undefined;
      await sleep(Math.min(hinted ?? backoff, maxMs), signal);
    }
  }
}

/**
 * Circuit breaker на провайдера. Після N невдач поспіль «розмикаємо коло» на cooldown:
 * не мучимо провайдера, який лежить, і одразу йдемо в fallback.
 * Після cooldown пропускаємо один пробний запит (half-open).
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    readonly name: string,
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  assertCanCall(): void {
    if (this.state === "open") throw new HttpError(503, `Circuit breaker для ${this.name} відкритий`);
  }

  success(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  failure(): void {
    this.failures++;
    if (this.failures >= this.threshold || this.state === "half_open") this.openedAt = this.now();
  }
}

/** Таймаут на виклик + скасування, якщо клієнт відключився. */
export function upstreamSignal(clientSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout;
}
