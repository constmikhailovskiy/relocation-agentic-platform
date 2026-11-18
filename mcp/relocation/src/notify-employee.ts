import { z } from "zod";
import { type Ctx, authorizeSearch, invalidInput } from "./context.ts";

/**
 * Вхід — strictObject: зайве поле (наприклад, `to`) — помилка, а не «тихо проігнорували».
 * Так модель одразу бачить, що адресата задати не можна. Обмеження: через MCP таку спробу відкидає ще SDK,
 * до домену — тож події аудиту про неї немає (повний аудит усіх викликів — етап 4).
 */
export const NotifyInput = z.strictObject({
  message: z.string().trim().min(1).max(1000),
});

/**
 * notify_employee(search_id, message). Адресат — завжди власник пошуку, адресу бере сервер з довідника.
 * Інструмента з довільним адресатом немає — і немає каналу, яким injection міг би вивести дані назовні.
 */
/** Ключ ідемпотентності генерує runtime (наприклад `${runId}:${step}`), а не модель — тому він не в input. */
const IdempotencyKey = z.string().min(1).max(128);

export function notifyEmployee(ctx: Ctx, searchId: string, input: unknown, opts: { idempotencyKey?: unknown } = {}): { sent: true; to: string } {
  const { search } = authorizeSearch(ctx, "notify_employee", "search.notify_employee", ctx.store.searchById(searchId), searchId);

  const parsed = NotifyInput.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);

  let key: string | undefined;
  if (opts.idempotencyKey !== undefined) {
    const k = IdempotencyKey.safeParse(opts.idempotencyKey);
    if (!k.success) throw invalidInput(k.error);
    key = k.data;
    // Повтор з тим самим ключем: та сама відповідь, листа вдруге немає. Саме це потрібно ретраю activity в Temporal.
    const previous = ctx.store.sentWithKey(search.id, key);
    if (previous) return previous;
  }

  const owner = ctx.store.employee(search.employeeId);
  if (!owner) throw new Error(`Власник пошуку ${search.id} відсутній у довіднику`);

  ctx.store.send({
    to: owner.email,
    searchId: search.id,
    message: parsed.data.message,
    sentBy: ctx.principal.sub,
    ...(ctx.principal.act && { agent: ctx.principal.act.sub }),
  });
  // Моделі — лише id людини, не email: адреса їй не потрібна.
  const result = { sent: true as const, to: owner.id };
  if (key !== undefined) ctx.store.rememberKey(search.id, key, result);
  return result;
}
