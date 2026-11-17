import { argsHash, assertTransition } from "@reloc/shared";
import { z } from "zod";
import { type Ctx, RelocationError, assertOpen, authorizeSearch, canRead, invalidInput, writeAudit } from "./context.ts";

/** Статуси, з яких можна просити перегляд: шортлист уже є. */
const VIEWABLE = new Set(["shortlist_ready", "viewing_requested"]);

export interface ViewingRequest {
  approvalId: string;
  status: "pending_confirmation" | "confirmed";
  listingKey: string;
  slots: string[];
  argsHash: string;
}

/**
 * request_viewing(search_id, listing_key, slots) — ІНСТРУМЕНТ. Нічого не відправляє орендодавцю:
 * лише створює запит у стані pending_confirmation, прив'язаний до args_hash. Runtime покаже користувачу
 * саме ці аргументи і після «так» викличе confirmViewing з тим самим хешем.
 */
export function requestViewing(ctx: Ctx, searchId: string, listingKey: unknown, slots: unknown): ViewingRequest {
  const { search } = authorizeSearch(ctx, "request_viewing", "search.request_viewing", ctx.store.searchById(searchId), searchId);
  assertOpen(search);

  const now = ctx.now();
  const Input = z.object({
    listingKey: z.string().min(1).max(64),
    // Слоти — у майбутньому відносно годинника сервера; не більше трьох варіантів.
    slots: z.array(z.iso.datetime().refine((s) => s > now, "слот має бути в майбутньому")).min(1).max(3),
  });
  const parsed = Input.safeParse({ listingKey, slots });
  if (!parsed.success) throw invalidInput(parsed.error);

  if (!VIEWABLE.has(search.status)) {
    throw new RelocationError("wrong_status", `Перегляд можна просити лише зі статусу shortlist_ready, зараз ${search.status}`);
  }
  // Лише з шортлиста: навіть якщо опис оголошення переконає модель «записати на перегляд» іншу квартиру,
  // сервер прийме тільки те, що вже пройшло через save_shortlist.
  if (!ctx.store.shortlist(search.id).some((i) => i.listingKey === parsed.data.listingKey)) {
    throw new RelocationError("not_in_shortlist", `Оголошення ${parsed.data.listingKey} немає в шортлисті. Спершу save_shortlist.`);
  }

  // Порядок слотів не важить: сортуємо до хешування, щоб [a,b] і [b,a] були тим самим запитом.
  const args = { searchId: search.id, listingKey: parsed.data.listingKey, slots: [...parsed.data.slots].sort() };
  const hash = argsHash(args);

  // Лише СВІЙ запит: однаковий хеш у Тараса й Олени — це два різні запити від двох людей.
  const existing = ctx.store.findApproval(
    (a) => a.kind === "viewing" && a.argsHash === hash && a.requestedBy === ctx.principal.sub && a.status === "pending_confirmation",
  );
  const approval =
    existing ??
    ctx.store.addApproval({
      kind: "viewing",
      searchId: search.id,
      requestedBy: ctx.principal.sub,
      ...(ctx.principal.act && { agent: ctx.principal.act.sub }),
      listingKey: args.listingKey,
      slots: args.slots,
      argsHash: hash,
      status: "pending_confirmation",
    });
  if (approval.kind !== "viewing") throw new Error("unreachable");
  return { approvalId: approval.id, status: approval.status, listingKey: approval.listingKey, slots: approval.slots, argsHash: approval.argsHash };
}

/**
 * Підтвердження людиною. НЕ інструмент MCP: його викликає runtime (етап 3) після відповіді користувача.
 *  - лише сам користувач, без агента (`act` → forbidden): агент не підтверджує сам собі;
 *  - лише той, хто просив: Тарас не підтверджує за Олену;
 *  - хеш має збігтися з тим, що бачив користувач: підміна слота після показу → args_mismatch.
 */
export function confirmViewing(ctx: Ctx, approvalId: string, shownHash: string): ViewingRequest {
  const approval = ctx.store.approval(approvalId);
  const deny = (code: "not_found" | "forbidden", reason: string, message: string): never => {
    writeAudit(ctx, "relocation.confirm_viewing", approvalId, "deny", reason);
    throw new RelocationError(code, message);
  };

  const search = approval && ctx.store.searchById(approval.searchId);
  if (!approval || approval.kind !== "viewing" || !search) return deny("not_found", "not_found", "Запит на перегляд не знайдено");
  if (approval.requestedBy !== ctx.principal.sub) {
    // Та сама логіка, що в authorizeSearch: хто пошуку не бачить, не дізнається й про запит.
    return canRead(ctx, search)
      ? deny("forbidden", "not_requester", "Підтверджує лише той, хто просив перегляд")
      : deny("not_found", "not_requester", "Запит на перегляд не знайдено");
  }
  if (ctx.principal.act) return deny("forbidden", "agent_cannot_confirm", "Підтверджує лише користувач, не агент");
  if (approval.status !== "pending_confirmation") throw new RelocationError("already_decided", "Запит уже підтверджено");
  if (approval.argsHash !== shownHash) {
    writeAudit(ctx, "relocation.confirm_viewing", approvalId, "deny", "args_mismatch");
    throw new RelocationError("args_mismatch", "Аргументи змінились після показу користувачу. Покажи запит ще раз.");
  }

  if (search.status === "shortlist_ready") {
    assertTransition(search.status, "viewing_requested");
    ctx.store.changeStatus(search.id, {
      from: search.status,
      to: "viewing_requested",
      reason: `Перегляд ${approval.listingKey} підтверджено користувачем`,
      by: ctx.principal.sub,
      at: ctx.now(),
    });
  } else if (search.status !== "viewing_requested") {
    throw new RelocationError("wrong_status", `Пошук у статусі ${search.status}, перегляд підтвердити не можна`);
  }

  const done = ctx.store.decide(approval.id, "confirmed", ctx.principal.sub);
  writeAudit(ctx, "relocation.confirm_viewing", approvalId, "allow", "requester");
  if (done.kind !== "viewing") throw new Error("unreachable");
  return { approvalId: done.id, status: done.status, listingKey: done.listingKey, slots: done.slots, argsHash: done.argsHash };
}
