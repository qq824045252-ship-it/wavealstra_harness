import type Database from "better-sqlite3";
import { RuntimeAuditUnknownOperationError, type RuntimeAuditReader } from "../platform/runtime-audit";

export interface DeferredRequirement {
  id: string;
  conversationId: number;
  taskId: string;
  prerequisiteId: string;
  text: string;
}

export type DeferredRow = DeferredRequirement & { operationId: string | null; applied: number };
export type DeferredReservation = Pick<DeferredRequirement, "id" | "conversationId"> & { originalTaskId: string };
export type DeferredPending = Pick<DeferredRequirement, "id" | "text" | "prerequisiteId"> & { status: string };
export type DeferredRouting = {
  requirement: DeferredRow;
  prerequisiteStatus: string | null;
  attempt: { sourceMessageId: string; status: string } | null;
};
export type DeferredRequirementsQuery =
  | { kind: "get"; id: string; conversationId: number }
  | { kind: "pending"; taskId: string; conversationId: number }
  | { kind: "candidates"; conversationId: number; sourceId: string; taskId?: string; spaceId?: string };
export type DeferredRequirementsCommand =
  | { kind: "save"; requirement: DeferredRequirement; sourceId: string }
  | { kind: "accept"; taskId: string; operationId: string; submissionId: number };
type SaveResult = { status: "saved"; row: DeferredRow } | { status: "conflict" | "scopeChanged" };
type AcceptResult = { status: "accepted" | "unreserved" | "receiptMissing" };
type DotsNative = Pick<RuntimeAuditReader, "batch4aWrite" | "supervised" | "dotsDeferredRead" | "dotsDeferredWrite">;

export class DotsDeferredRequirements {
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingRows = new Map<string, DeferredRow>();

  constructor(private readonly fixture: Database.Database | undefined, private readonly native?: DotsNative) {
    if (fixture && !fixture.readonly) {
      fixture.exec("CREATE TABLE IF NOT EXISTS dots_deferred_requirements (" +
        "id TEXT PRIMARY KEY, conversationId INTEGER NOT NULL, taskId TEXT NOT NULL, prerequisiteId TEXT NOT NULL, " +
        "text TEXT NOT NULL, operationId TEXT, applied INTEGER NOT NULL DEFAULT 0)");
    }
  }

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("Dots 待办需要 Core 数据库");
    return this.fixture;
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.native?.supervised);
  }

  flush(): Promise<void> {
    return this.writeTail;
  }

  private async readCore<T>(query: DeferredRequirementsQuery): Promise<T> {
    const reply = await this.native?.dotsDeferredRead<T>(query);
    if (reply === undefined) throw new Error("Core 未确认 Dots 待办状态");
    return reply;
  }

  private async writeCore<T>(command: DeferredRequirementsCommand): Promise<T> {
    const write = () => this.native?.dotsDeferredWrite<T>(command) ?? Promise.resolve(undefined);
    const reply = await write().catch(error => {
      if (error instanceof RuntimeAuditUnknownOperationError) return write();
      throw error;
    });
    if (reply === undefined) throw new Error("Core 未确认 Dots 待办写入");
    return reply;
  }

  async read(id: string, conversationId: number): Promise<DeferredRow | undefined> {
    if (this.fixture) return this.get(id, conversationId);
    return (await this.readCore<DeferredRouting | null>({ kind: "get", id, conversationId }))?.requirement;
  }

  async readRouting(id: string, conversationId: number): Promise<DeferredRouting | undefined> {
    if (!this.fixture) return (await this.readCore<DeferredRouting | null>({ kind: "get", id, conversationId })) ?? undefined;
    const requirement = this.get(id, conversationId);
    if (!requirement) return undefined;
    const prerequisiteStatus = this.fixture.prepare("SELECT status FROM dots_delegations WHERE operation_id=?").pluck()
      .get(requirement.prerequisiteId) as string | undefined;
    const attempt = this.fixture.prepare("SELECT source_message_id AS sourceMessageId,status FROM dots_delegations WHERE operation_id=?")
      .get(requirement.operationId) as DeferredRouting["attempt"] | undefined;
    return { requirement, prerequisiteStatus: prerequisiteStatus ?? null, attempt: attempt ?? null };
  }

  async readPending(taskId: string, conversationId: number | undefined): Promise<DeferredPending[]> {
    if (conversationId === undefined) return [];
    if (this.fixture) return this.pending(taskId, conversationId);
    return this.readCore({ kind: "pending", taskId, conversationId });
  }

  async readCandidates(conversationId: number, sourceId: string, taskId?: string, spaceId?: string): Promise<string[]> {
    if (this.fixture) return this.candidates(conversationId, sourceId, taskId, spaceId);
    return this.readCore({ kind: "candidates", conversationId, sourceId, taskId, spaceId });
  }

  async saveConfirmed(requirement: DeferredRequirement, sourceId: string): Promise<DeferredRow> {
    if (this.fixture) return this.save(requirement);
    const reply = await this.writeCore<SaveResult>({ kind: "save", requirement, sourceId });
    if (reply.status === "saved") return reply.row;
    if (reply.status === "scopeChanged") throw new Error("原交办或工作空间已变化，请核对后保存待办。");
    throw new Error("这条待办已属于其他对话或任务。");
  }

  async acceptConfirmed(operationId: string, taskId: string, submissionId: number): Promise<void> {
    if (this.fixture) return this.accepted(operationId);
    const reply = await this.writeCore<AcceptResult>({ kind: "accept", taskId, operationId, submissionId });
    if (reply.status === "receiptMissing") throw new Error("Core 尚未确认带有待办的原任务受理回执。");
  }

  private enqueue(request: Record<string, unknown>, label: string): void {
    const batch4a = this.native?.batch4aWrite;
    if (!batch4a) throw new Error(`只读模式下缺少 Dots 待办 Rust 写入通道: ${label}`);
    this.pendingWriteCount += 1;
    this.writeTail = this.writeTail.then(() => batch4a.call(this.native, request)).then(() => undefined, error => {
      console.warn(`[DotsDeferredRequirements] ${label} failed`, error);
    }).finally(() => {
      this.pendingWriteCount -= 1;
      if (this.pendingWriteCount === 0) this.pendingRows.clear();
    });
  }

  save(requirement: DeferredRequirement) {
    if (this.requiresRustWrites) {
      const existing = this.get(requirement.id, requirement.conversationId);
      if (existing) return existing;
      const row: DeferredRow = { ...requirement, operationId: null, applied: 0 };
      this.pendingRows.set(requirement.id, row);
      this.enqueue({
        kind: "dotsDeferredSave",
        id: requirement.id,
        conversationId: requirement.conversationId,
        taskId: requirement.taskId,
        prerequisiteId: requirement.prerequisiteId,
        text: requirement.text,
      }, "save");
      return row;
    }
    this.db.prepare("INSERT OR IGNORE INTO dots_deferred_requirements (id,conversationId,taskId,prerequisiteId,text) VALUES (?,?,?,?,?)")
      .run(requirement.id, requirement.conversationId, requirement.taskId, requirement.prerequisiteId, requirement.text);
    return this.get(requirement.id, requirement.conversationId)!;
  }

  get(id: string, conversationId: number) {
    const pending = this.pendingRows.get(id);
    if (pending && pending.conversationId === conversationId) return pending;
    return this.db.prepare("SELECT * FROM dots_deferred_requirements WHERE id=? AND conversationId=?")
      .get(id, conversationId) as DeferredRow | undefined;
  }

  pending(taskId: string, conversationId: number | undefined) {
    if (conversationId === undefined) return [];
    const rows = this.db.prepare("SELECT r.id,r.text,r.prerequisiteId,d.status FROM dots_deferred_requirements r " +
      "JOIN dots_delegations d ON d.operation_id=r.prerequisiteId " +
      "LEFT JOIN dots_delegations attempt ON attempt.operation_id=r.operationId " +
      "WHERE r.taskId=? AND r.conversationId=? AND r.applied=0 AND (r.operationId IS NULL OR attempt.status='failed') ORDER BY r.rowid")
      .all(taskId, conversationId) as Array<{ id: string; text: string; prerequisiteId: string; status: string }>;
    if (!this.pendingRows.size) return rows;
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const row of this.pendingRows.values()) {
      if (row.taskId !== taskId || row.conversationId !== conversationId) continue;
      if (row.applied) {
        byId.delete(row.id);
        continue;
      }
      if (!byId.has(row.id) && row.operationId === null) {
        const prereq = this.db.prepare("SELECT status FROM dots_delegations WHERE operation_id=?").get(row.prerequisiteId) as { status: string } | undefined;
        if (prereq) byId.set(row.id, { id: row.id, text: row.text, prerequisiteId: row.prerequisiteId, status: prereq.status });
      }
    }
    return [...byId.values()];
  }

  candidates(conversationId: number, sourceId: string, taskId?: string, spaceId?: string) {
    return (this.db.prepare("SELECT r.id FROM dots_deferred_requirements r JOIN tasks t ON t.id=r.taskId " +
      "LEFT JOIN dots_delegations attempt ON attempt.operation_id=r.operationId " +
      "WHERE r.conversationId=? AND (r.taskId=? OR (? IS NULL AND t.space_id=?)) AND " +
      "(attempt.source_message_id=? OR (r.applied=0 AND (r.operationId IS NULL OR attempt.status='failed'))) ORDER BY r.rowid LIMIT 2")
      .all(conversationId, taskId ?? null, taskId ?? null, spaceId ?? null, sourceId) as { id: string }[]).map(row => row.id);
  }

  reserve(id: string, operationId: string) {
    if (this.requiresRustWrites) {
      const current = this.pendingRows.get(id) ?? (this.db.prepare("SELECT * FROM dots_deferred_requirements WHERE id=?").get(id) as DeferredRow | undefined);
      const attempt = current?.operationId
        ? (this.db.prepare("SELECT status FROM dots_delegations WHERE operation_id=?").get(current.operationId) as { status: string } | undefined)
        : undefined;
      const reservable = current && (current.operationId === operationId
        || (current.applied === 0 && (current.operationId === null || attempt?.status === "failed")));
      if (!reservable) throw new Error("这条待办已关联其他交办，请核对原任务。");
      this.pendingRows.set(id, { ...current, operationId });
      this.enqueue({ kind: "dotsDeferredReserve", id, operationId }, "reserve");
      return;
    }
    const reserved = this.db.prepare("UPDATE dots_deferred_requirements SET operationId=? WHERE id=? AND " +
      "(operationId=? OR (applied=0 AND (operationId IS NULL OR EXISTS " +
      "(SELECT 1 FROM dots_delegations d WHERE d.operation_id=dots_deferred_requirements.operationId AND d.status='failed'))))")
      .run(operationId, id, operationId).changes;
    if (!reserved) throw new Error("这条待办已关联其他交办，请核对原任务。");
  }

  accepted(operationId: string) {
    if (this.requiresRustWrites) {
      for (const [id, row] of this.pendingRows) {
        if (row.operationId === operationId && row.applied === 0) {
          this.pendingRows.set(id, { ...row, applied: 1 });
        }
      }
      this.enqueue({ kind: "dotsDeferredAccepted", operationId }, "accepted");
      return;
    }
    this.db.prepare("UPDATE dots_deferred_requirements SET applied=1 WHERE operationId=? AND applied=0").run(operationId);
  }
}
