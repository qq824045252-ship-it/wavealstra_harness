import type Database from "better-sqlite3";
import type { RuntimeAuditReader } from "../platform/runtime-audit";

interface DeferredRequirement {
  id: string;
  conversationId: number;
  taskId: string;
  prerequisiteId: string;
  text: string;
}

type DeferredRow = DeferredRequirement & { operationId: string | null; applied: number };
type DotsNative = Pick<RuntimeAuditReader, "batch4aWrite" | "supervised">;

export class DotsDeferredRequirements {
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingRows = new Map<string, DeferredRow>();

  constructor(private readonly db: Database.Database, private readonly native?: DotsNative) {
    if (!db.readonly) {
      db.exec("CREATE TABLE IF NOT EXISTS dots_deferred_requirements (" +
        "id TEXT PRIMARY KEY, conversationId INTEGER NOT NULL, taskId TEXT NOT NULL, prerequisiteId TEXT NOT NULL, " +
        "text TEXT NOT NULL, operationId TEXT, applied INTEGER NOT NULL DEFAULT 0)");
    }
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.native?.supervised);
  }

  flush(): Promise<void> {
    return this.writeTail;
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
