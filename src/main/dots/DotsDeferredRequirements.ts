import type Database from "better-sqlite3";

interface DeferredRequirement {
  id: string;
  conversationId: number;
  taskId: string;
  prerequisiteId: string;
  text: string;
}

export class DotsDeferredRequirements {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS dots_deferred_requirements (" +
      "id TEXT PRIMARY KEY, conversationId INTEGER NOT NULL, taskId TEXT NOT NULL, prerequisiteId TEXT NOT NULL, " +
      "text TEXT NOT NULL, operationId TEXT, applied INTEGER NOT NULL DEFAULT 0)");
  }

  save(requirement: DeferredRequirement) {
    this.db.prepare("INSERT OR IGNORE INTO dots_deferred_requirements (id,conversationId,taskId,prerequisiteId,text) VALUES (?,?,?,?,?)")
      .run(requirement.id, requirement.conversationId, requirement.taskId, requirement.prerequisiteId, requirement.text);
    return this.get(requirement.id, requirement.conversationId)!;
  }

  get(id: string, conversationId: number) {
    return this.db.prepare("SELECT * FROM dots_deferred_requirements WHERE id=? AND conversationId=?")
      .get(id, conversationId) as (DeferredRequirement & { operationId: string | null; applied: number }) | undefined;
  }

  pending(taskId: string, conversationId: number | undefined) {
    if (conversationId === undefined) return [];
    return this.db.prepare("SELECT r.id,r.text,r.prerequisiteId,d.status FROM dots_deferred_requirements r " +
      "JOIN dots_delegations d ON d.operation_id=r.prerequisiteId " +
      "LEFT JOIN dots_delegations attempt ON attempt.operation_id=r.operationId " +
      "WHERE r.taskId=? AND r.conversationId=? AND r.applied=0 AND (r.operationId IS NULL OR attempt.status='failed') ORDER BY r.rowid")
      .all(taskId, conversationId);
  }

  candidates(conversationId: number, sourceId: string, taskId?: string, spaceId?: string) {
    return (this.db.prepare("SELECT r.id FROM dots_deferred_requirements r JOIN tasks t ON t.id=r.taskId " +
      "LEFT JOIN dots_delegations attempt ON attempt.operation_id=r.operationId " +
      "WHERE r.conversationId=? AND (r.taskId=? OR (? IS NULL AND t.space_id=?)) AND " +
      "(attempt.source_message_id=? OR (r.applied=0 AND (r.operationId IS NULL OR attempt.status='failed'))) ORDER BY r.rowid LIMIT 2")
      .all(conversationId, taskId ?? null, taskId ?? null, spaceId ?? null, sourceId) as { id: string }[]).map(row => row.id);
  }

  reserve(id: string, operationId: string) {
    const reserved = this.db.prepare("UPDATE dots_deferred_requirements SET operationId=? WHERE id=? AND " +
      "(operationId=? OR (applied=0 AND (operationId IS NULL OR EXISTS " +
      "(SELECT 1 FROM dots_delegations d WHERE d.operation_id=dots_deferred_requirements.operationId AND d.status='failed'))))")
      .run(operationId, id, operationId).changes;
    if (!reserved) throw new Error("这条待办已关联其他交办，请核对原任务。");
  }

  accepted(operationId: string) {
    this.db.prepare("UPDATE dots_deferred_requirements SET applied=1 WHERE operationId=? AND applied=0").run(operationId);
  }
}
