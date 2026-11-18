import { type Criteria, Employee, Search, type SearchStatus, type ShortlistItem } from "@reloc/shared";
import { z } from "zod";

/**
 * Сховище сервера relocation. Етап 2 — у пам'яті; у плані SQLite (`node:sqlite`) з тими ж методами,
 * тож обробники інструментів від цього не зміняться.
 *
 * Створюється ОДИН раз на процес (у loadDeps), а не на кожен запит: на відміну від McpServer,
 * це стан, і він має пережити запит.
 */
/** Запит на схвалення (таблиця approvals з case.md). Агент може лише СТВОРИТИ його; вирішує людина. */
export type Approval = {
  id: string;
  searchId: string;
  /** Користувач, від імені якого створено (sub), і агент, якщо через агента (act). */
  requestedBy: string;
  agent?: string;
  decidedBy?: string;
} & (
  | { kind: "viewing"; listingKey: string; slots: string[]; argsHash: string; expiresAt: string; status: "pending_confirmation" | "confirmed" }
  | { kind: "budget_exception"; amountUah: number; reason: string; status: "pending" | "approved" | "rejected" }
);

/** Лист у вихідній черзі. Адресу бере сервер, не модель. */
export interface OutboxMessage {
  to: string;
  searchId: string;
  message: string;
  sentBy: string;
  agent?: string;
}

/** Запис в історії статусів: що, чому, хто (і через якого агента), коли. */
export interface StatusChange {
  from: SearchStatus;
  to: SearchStatus;
  reason: string;
  by: string;
  agent?: string;
  at: string;
}

// Omit<T, K> — тип T без поля K. Але Omit над union «злипає» варіанти в один (і губить kind-специфічні поля).
// `T extends unknown ? ... : never` — умовний тип, який TS застосовує до КОЖНОГО варіанта union окремо.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewApproval = DistributiveOmit<Approval, "id">;

export class RelocationStore {
  // `private readonly`: поле можна задати лише в конструкторі, і ззовні класу його не видно.
  private readonly searches = new Map<string, Search>();
  private readonly employees = new Map<string, Employee>();
  private readonly shortlists = new Map<string, ShortlistItem[]>();
  private readonly approvals = new Map<string, Approval>();
  private readonly messages: OutboxMessage[] = [];
  private readonly history = new Map<string, StatusChange[]>();
  /** Ключі ідемпотентності листів: `${searchId}\u0000${key}` → відповідь першого виклику. */
  private readonly sentKeys = new Map<string, { sent: true; to: string }>();
  private nextApprovalId = 1;

  private constructor(searches: readonly Search[], employees: readonly Employee[]) {
    for (const s of searches) this.searches.set(s.id, s);
    for (const e of employees) this.employees.set(e.id, e);
  }

  /** Сирі дані (фікстури або міграція) → перевірка схемою. Биті дані валять старт, а не запит агента. */
  static fromSeed(seed: { searches: unknown; employees: unknown }): RelocationStore {
    return new RelocationStore(z.array(Search).parse(seed.searches), z.array(Employee).parse(seed.employees));
  }

  /** Для /health: лише кількість, без даних. */
  searchCount(): number {
    return this.searches.size;
  }

  employee(id: string): Employee | undefined {
    return this.employees.get(id);
  }

  searchByEmployee(employeeId: string): Search | undefined {
    for (const s of this.searches.values()) if (s.employeeId === employeeId) return s;
    return undefined;
  }

  searchById(id: string): Search | undefined {
    return this.searches.get(id);
  }

  /** Пошуки не мутуємо на місці: кладемо новий об'єкт. Те, що хтось уже прочитав, не зміниться під ним. */
  updateCriteria(searchId: string, criteria: Criteria): Search {
    return this.replace(searchId, { criteria });
  }

  /** Без перевірки переходу й без історії — для підготовки стану в тестах і міграцій. */
  setStatus(searchId: string, status: SearchStatus): Search {
    return this.replace(searchId, { status });
  }

  /** Зміна статусу з записом в історію. Перевірку переходу робить виклик (update_status, confirmViewing). */
  changeStatus(searchId: string, change: StatusChange): Search {
    this.history.set(searchId, [...this.statusHistory(searchId), change]);
    return this.replace(searchId, { status: change.to });
  }

  statusHistory(searchId: string): readonly StatusChange[] {
    return this.history.get(searchId) ?? [];
  }

  /** Після схваленого винятку ліміт пошуку піднімається до схваленої суми. */
  raiseCap(searchId: string, capUah: number): Search {
    return this.replace(searchId, { companyCapUah: capUah });
  }

  addApproval(a: NewApproval): Approval {
    const approval = { ...a, id: `appr-${this.nextApprovalId++}` } as Approval;
    this.approvals.set(approval.id, approval);
    return approval;
  }

  approval(id: string): Approval | undefined {
    return this.approvals.get(id);
  }

  findApproval(pred: (a: Approval) => boolean): Approval | undefined {
    for (const a of this.approvals.values()) if (pred(a)) return a;
    return undefined;
  }

  decide(id: string, status: Approval["status"], decidedBy: string): Approval {
    const current = this.approvals.get(id);
    if (!current) throw new Error(`Approval ${id} відсутній у сховищі`);
    const next = { ...current, status, decidedBy } as Approval;
    this.approvals.set(id, next);
    return next;
  }

  send(message: OutboxMessage): void {
    this.messages.push(message);
  }

  /** Відповідь, уже видана для цього ключа (або undefined). У SQLite — таблиця з PRIMARY KEY (search_id, key). */
  sentWithKey(searchId: string, key: string): { sent: true; to: string } | undefined {
    return this.sentKeys.get(`${searchId}\u0000${key}`);
  }

  rememberKey(searchId: string, key: string, result: { sent: true; to: string }): void {
    this.sentKeys.set(`${searchId}\u0000${key}`, result);
  }

  outbox(): readonly OutboxMessage[] {
    return this.messages;
  }

  // Partial<Search> — тип «будь-яка підмножина полів Search»; spread накладає зміни на старий запис.
  private replace(searchId: string, patch: Partial<Search>): Search {
    const current = this.searches.get(searchId);
    if (!current) throw new Error(`Пошук ${searchId} відсутній у сховищі`);
    const next = { ...current, ...patch };
    this.searches.set(searchId, next);
    return next;
  }

  shortlist(searchId: string): readonly ShortlistItem[] {
    return this.shortlists.get(searchId) ?? [];
  }

  /**
   * Ідемпотентно за (searchId, listingKey): наявний ключ не перезаписується (перший reason виграє).
   * У SQLite це буде PRIMARY KEY (search_id, listing_key) + INSERT ... ON CONFLICT DO NOTHING.
   */
  addShortlistItems(searchId: string, items: readonly ShortlistItem[]): { added: string[]; alreadyPresent: string[]; total: number } {
    const current = [...this.shortlist(searchId)];
    // Set — множина без повторів; .has() перевіряє наявність за O(1).
    const seen = new Set(current.map((i) => i.listingKey));
    const added: string[] = [];
    const alreadyPresent: string[] = [];
    for (const item of items) {
      if (seen.has(item.listingKey)) {
        // Дубль усередині одного виклику не має потрапити в alreadyPresent як «уже було».
        if (!added.includes(item.listingKey) && !alreadyPresent.includes(item.listingKey)) alreadyPresent.push(item.listingKey);
        continue;
      }
      seen.add(item.listingKey);
      current.push(item);
      added.push(item.listingKey);
    }
    this.shortlists.set(searchId, current);
    return { added, alreadyPresent, total: current.length };
  }
}
