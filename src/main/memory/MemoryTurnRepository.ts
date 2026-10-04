import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryPipelineStateDto, MemoryTurnDto, MemoryTurnExtractionState, MemoryTurnListRequest } from "../../shared/memory-kernel";

function hashTurn(userText: string, assistantText: string): string {
  return createHash("sha256").update(`${userText}\n\u241e\n${assistantText}`).digest("hex");
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export interface CaptureMemoryTurnInput {
  taskId: string;
  sessionId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  userText: string;
  assistantText: string;
  metadata?: Record<string, unknown>;
  capturedAt?: number;
}

export class MemoryTurnRepository {
  constructor(private readonly db: AppDatabase) {}
  private get conn() { return this.db.connection; }

  capture(input: CaptureMemoryTurnInput): { turn: MemoryTurnDto; created: boolean } {
    const userText = input.userText.trim();
    const assistantText = input.assistantText.trim();
    const capturedAt = input.capturedAt ?? Date.now();
    const contentHash = hashTurn(userText, assistantText);
    const existing = input.assistantMessageId
      ? this.getByAssistantMessageId(input.assistantMessageId)
      : this.getByTaskAndHash(input.taskId, contentHash);
    if (existing) return { turn: existing, created: false };

    const id = `mturn_${randomUUID()}`;
    this.conn.prepare(
      `INSERT INTO memory_turns (
        id,task_id,session_id,user_message_id,assistant_message_id,user_text,assistant_text,content_hash,
        captured_at,extraction_state,extracted_at,attempt_count,last_error,metadata_json
      ) VALUES (?,?,?,?,?,?,?,?,?,'pending',NULL,0,NULL,?)`,
    ).run(
      id,
      input.taskId,
      input.sessionId ?? null,
      input.userMessageId ?? null,
      input.assistantMessageId ?? null,
      userText,
      assistantText,
      contentHash,
      capturedAt,
      JSON.stringify(input.metadata ?? {}),
    );
    return { turn: this.get(id)!, created: true };
  }

  get(id: string): MemoryTurnDto | undefined {
    const row = this.conn.prepare(`SELECT m.*,t.title AS task_title,w.state AS task_workspace_state
      FROM memory_turns m LEFT JOIN tasks t ON t.id=m.task_id
      LEFT JOIN task_execution_workspace_state w ON w.task_id=m.task_id WHERE m.id=?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapTurn(row) : undefined;
  }

  getByAssistantMessageId(messageId: string): MemoryTurnDto | undefined {
    const row = this.conn.prepare("SELECT * FROM memory_turns WHERE assistant_message_id=?").get(messageId) as Record<string, unknown> | undefined;
    return row ? this.mapTurn(row) : undefined;
  }

  getByTaskAndHash(taskId: string, contentHash: string): MemoryTurnDto | undefined {
    const row = this.conn.prepare(
      "SELECT * FROM memory_turns WHERE task_id=? AND content_hash=? ORDER BY captured_at DESC LIMIT 1",
    ).get(taskId, contentHash) as Record<string, unknown> | undefined;
    return row ? this.mapTurn(row) : undefined;
  }

  listByTask(taskId: string, limit = 100): MemoryTurnDto[] {
    return (this.conn.prepare(
      "SELECT * FROM memory_turns WHERE task_id=? ORDER BY captured_at DESC,id DESC LIMIT ?",
    ).all(taskId, Math.max(1, Math.min(1000, limit))) as Array<Record<string, unknown>>).map((row) => this.mapTurn(row));
  }

  historicalUserInputs(sessionId: string, taskId?: string): Array<{ id: string; userText: string }> {
    // Only the host's persisted conversation lineage may widen the proof lookup.
    // A path in a session header or a renderer request is not lineage authority.
    return (this.conn.prepare(`
      WITH RECURSIVE ancestors(child_task_id,parent_task_id,source_session_file) AS (
        SELECT child_task_id,parent_task_id,source_session_file FROM conversation_branches WHERE child_task_id=?
        UNION
        SELECT b.child_task_id,b.parent_task_id,b.source_session_file FROM conversation_branches b
          JOIN ancestors a ON b.child_task_id=a.parent_task_id
      )
      SELECT id,user_text FROM memory_turns
      WHERE session_id=? OR session_id IN (SELECT source_session_file FROM ancestors)
      ORDER BY captured_at,id
    `).all(taskId ?? null, sessionId) as Array<{ id: string; user_text: string }>).map((row) => ({ id: row.id, userText: row.user_text }));
  }

  list(request: MemoryTurnListRequest = {}): MemoryTurnDto[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (request.taskId?.trim()) {
      where.push("m.task_id=?");
      args.push(request.taskId.trim());
    }
    if (request.extractionState) {
      where.push("extraction_state=?");
      args.push(request.extractionState);
    }
    const query = request.query?.trim();
    if (query) {
      where.push("(user_text LIKE ? OR assistant_text LIKE ?)");
      const like = `%${query}%`;
      args.push(like, like);
    }
    const limit = Math.max(1, Math.min(2000, request.limit ?? 300));
    args.push(limit);
    const sql = `SELECT m.*,t.title AS task_title,w.state AS task_workspace_state
      FROM memory_turns m LEFT JOIN tasks t ON t.id=m.task_id
      LEFT JOIN task_execution_workspace_state w ON w.task_id=m.task_id
      ${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY captured_at DESC,m.id DESC LIMIT ?`;
    return (this.conn.prepare(sql).all(...args) as Array<Record<string, unknown>>).map((row) => this.mapTurn(row));
  }

  listPending(taskId: string, limit = 8, capturedThrough = Number.MAX_SAFE_INTEGER): MemoryTurnDto[] {
    return (this.conn.prepare(
      `SELECT * FROM memory_turns
       WHERE task_id=? AND extraction_state IN ('pending','failed') AND attempt_count < 3 AND captured_at<=?
       ORDER BY captured_at ASC,id ASC LIMIT ?`,
    ).all(taskId, capturedThrough, Math.max(1, Math.min(50, limit))) as Array<Record<string, unknown>>).map((row) => this.mapTurn(row));
  }

  canExtractTask(taskId: string): boolean {
    const task = this.db.getTask(taskId);
    if (!task || this.db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") return false;
    if (task.projectId) {
      const project = this.conn.prepare("SELECT archived FROM projects WHERE id=?").get(task.projectId) as { archived: number } | undefined;
      if (!project || project.archived) return false;
    }
    return true;
  }

  listTaskOptions(): import("../../shared/memory-kernel").MemoryTurnTaskDto[] {
    return (this.conn.prepare(`SELECT DISTINCT m.task_id,t.title,w.state FROM memory_turns m
      LEFT JOIN tasks t ON t.id=m.task_id LEFT JOIN task_execution_workspace_state w ON w.task_id=m.task_id
      ORDER BY t.title,m.task_id`).all() as Array<{ task_id: string; title: string | null; state: string | null }>).map((row) => ({
      id: row.task_id, title: row.title || "原任务已删除", trashed: row.state === "trashed",
    }));
  }

  pendingTaskIds(): string[] {
    return (this.conn.prepare(`SELECT DISTINCT task_id FROM memory_turns
      WHERE extraction_state IN ('pending','failed') AND attempt_count < 3`).all() as Array<{ task_id: string }>).map((row) => row.task_id);
  }

  /** Remove all captured originals, keeping the bounded evidence owned by durable memories. */
  deleteAll(): number {
    return this.conn.transaction(() => {
      this.conn.prepare(`UPDATE memory_evidence
        SET excerpt = COALESCE(NULLIF(excerpt,''), (
          SELECT substr('用户：' || t.user_text || char(10) || '助手：' || t.assistant_text, 1, 1200)
          FROM memory_turns t WHERE t.id=memory_evidence.ref_id
        ))
        WHERE evidence_kind='conversation' AND ref_id IN (SELECT id FROM memory_turns)`).run();
      const deleted = this.conn.prepare("DELETE FROM memory_turns").run().changes;
      this.conn.prepare("DELETE FROM memory_pipeline_state").run();
      return deleted;
    })();
  }

  /** Delete only the requested originals and reconcile counters for their tasks atomically. */
  deleteMany(ids: readonly string[]): number {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return 0;
    return this.conn.transaction(() => {
      const find = this.conn.prepare("SELECT task_id FROM memory_turns WHERE id=?");
      const preserveEvidence = this.conn.prepare(`UPDATE memory_evidence
        SET excerpt = COALESCE(NULLIF(excerpt,''), (
          SELECT substr('用户：' || t.user_text || char(10) || '助手：' || t.assistant_text, 1, 1200)
          FROM memory_turns t WHERE t.id=memory_evidence.ref_id
        )) WHERE evidence_kind='conversation' AND ref_id=?`);
      const remove = this.conn.prepare("DELETE FROM memory_turns WHERE id=?");
      const taskIds = new Set<string>();
      let deleted = 0;
      for (const id of unique) {
        const row = find.get(id) as { task_id: string } | undefined;
        if (!row) continue;
        preserveEvidence.run(id);
        deleted += remove.run(id).changes;
        taskIds.add(row.task_id);
      }
      const recount = this.conn.prepare(`UPDATE memory_pipeline_state SET
        captured_turns=(SELECT COUNT(*) FROM memory_turns WHERE task_id=?),
        turns_since_l1=(SELECT COUNT(*) FROM memory_turns WHERE task_id=? AND extraction_state IN ('pending','failed','processing')),
        updated_at=? WHERE task_id=?`);
      const removeEmptyState = this.conn.prepare(`DELETE FROM memory_pipeline_state
        WHERE task_id=? AND NOT EXISTS (SELECT 1 FROM memory_turns WHERE task_id=?)`);
      for (const taskId of taskIds) {
        recount.run(taskId, taskId, Date.now(), taskId);
        removeEmptyState.run(taskId, taskId);
      }
      return deleted;
    })();
  }

  allExist(ids: readonly string[]): boolean {
    const find = this.conn.prepare("SELECT 1 FROM memory_turns WHERE id=?");
    return ids.every((id) => Boolean(find.get(id)));
  }

  /** A partially deleted batch must be extracted again using only its surviving sources. */
  requeueProcessing(ids: readonly string[]): void {
    const reset = this.conn.prepare(`UPDATE memory_turns
      SET extraction_state='pending',attempt_count=MAX(0,attempt_count-1),last_error=NULL
      WHERE id=? AND extraction_state='processing'`);
    this.conn.transaction(() => { for (const id of new Set(ids)) reset.run(id); })();
  }

  markProcessing(ids: readonly string[]): void {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return;
    const stmt = this.conn.prepare(
      "UPDATE memory_turns SET extraction_state='processing',attempt_count=attempt_count+1,last_error=NULL WHERE id=?",
    );
    this.conn.transaction(() => { for (const id of unique) stmt.run(id); })();
  }

  markCompleted(ids: readonly string[], now = Date.now()): void {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return;
    const stmt = this.conn.prepare(
      "UPDATE memory_turns SET extraction_state='completed',extracted_at=?,last_error=NULL WHERE id=?",
    );
    this.conn.transaction(() => { for (const id of unique) stmt.run(now, id); })();
  }

  markFailed(ids: readonly string[], error: unknown): void {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const stmt = this.conn.prepare(
      "UPDATE memory_turns SET extraction_state='failed',last_error=? WHERE id=?",
    );
    this.conn.transaction(() => { for (const id of unique) stmt.run(message, id); })();
  }

  /** Failed turns become pending again with a fresh attempt budget; caller may drive extraction via the returned task ids. */
  resetFailedTurns(): { reset: number; taskIds: string[] } {
    const rows = this.conn.prepare(
      "SELECT id, task_id FROM memory_turns WHERE extraction_state='failed'",
    ).all() as Array<{ id: string; task_id: string }>;
    const eligible = rows.filter((row) => this.canExtractTask(row.task_id));
    if (eligible.length === 0) return { reset: 0, taskIds: [] };
    const stmt = this.conn.prepare(
      "UPDATE memory_turns SET extraction_state='pending',attempt_count=0,last_error=NULL WHERE id=? AND extraction_state='failed'",
    );
    this.conn.transaction(() => { for (const row of eligible) stmt.run(row.id); })();
    return { reset: eligible.length, taskIds: [...new Set(eligible.map((row) => row.task_id))] };
  }

  getPipelineState(taskId: string): MemoryPipelineStateDto {
    const row = this.conn.prepare("SELECT * FROM memory_pipeline_state WHERE task_id=?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) {
      return {
        taskId,
        capturedTurns: 0,
        turnsSinceL1: 0,
        l1RunCount: 0,
        l2RunCount: 0,
        l3RunCount: 0,
        updatedAt: 0,
      };
    }
    return {
      taskId,
      capturedTurns: Number(row.captured_turns),
      turnsSinceL1: Number(row.turns_since_l1),
      lastL1At: row.last_l1_at == null ? undefined : Number(row.last_l1_at),
      lastL2At: row.last_l2_at == null ? undefined : Number(row.last_l2_at),
      lastL3At: row.last_l3_at == null ? undefined : Number(row.last_l3_at),
      l1RunCount: Number(row.l1_run_count),
      l2RunCount: Number(row.l2_run_count),
      l3RunCount: Number(row.l3_run_count),
      updatedAt: Number(row.updated_at),
    };
  }

  noteCaptured(taskId: string, now = Date.now()): MemoryPipelineStateDto {
    this.conn.prepare(
      `INSERT INTO memory_pipeline_state (
        task_id,captured_turns,turns_since_l1,last_l1_at,last_l2_at,last_l3_at,l1_run_count,l2_run_count,l3_run_count,updated_at
      ) VALUES (?,1,1,NULL,NULL,NULL,0,0,0,?)
      ON CONFLICT(task_id) DO UPDATE SET
        captured_turns=captured_turns+1,
        turns_since_l1=turns_since_l1+1,
        updated_at=excluded.updated_at`,
    ).run(taskId, now);
    return this.getPipelineState(taskId);
  }

  noteL1Completed(taskId: string, remainingPending = 0, now = Date.now()): MemoryPipelineStateDto {
    this.conn.prepare(
      `INSERT INTO memory_pipeline_state (
        task_id,captured_turns,turns_since_l1,last_l1_at,last_l2_at,last_l3_at,l1_run_count,l2_run_count,l3_run_count,updated_at
      ) VALUES (?,0,?,?,NULL,NULL,1,0,0,?)
      ON CONFLICT(task_id) DO UPDATE SET
        turns_since_l1=excluded.turns_since_l1,last_l1_at=excluded.last_l1_at,l1_run_count=l1_run_count+1,updated_at=excluded.updated_at`,
    ).run(taskId, Math.max(0, remainingPending), now, now);
    return this.getPipelineState(taskId);
  }

  countByState(state?: MemoryTurnExtractionState): number {
    const row = state
      ? this.conn.prepare("SELECT COUNT(1) n FROM memory_turns WHERE extraction_state=?").get(state)
      : this.conn.prepare("SELECT COUNT(1) n FROM memory_turns").get();
    return Number((row as { n: number }).n);
  }

  private mapTurn(row: Record<string, unknown>): MemoryTurnDto {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      taskTitle: row.task_title ? String(row.task_title) : undefined,
      taskTrashed: row.task_workspace_state === "trashed",
      sessionId: row.session_id ? String(row.session_id) : undefined,
      userMessageId: row.user_message_id ? String(row.user_message_id) : undefined,
      assistantMessageId: row.assistant_message_id ? String(row.assistant_message_id) : undefined,
      userText: String(row.user_text ?? ""),
      assistantText: String(row.assistant_text ?? ""),
      contentHash: String(row.content_hash),
      capturedAt: Number(row.captured_at),
      extractionState: row.extraction_state as MemoryTurnExtractionState,
      extractedAt: row.extracted_at == null ? undefined : Number(row.extracted_at),
      attemptCount: Number(row.attempt_count),
      lastError: row.last_error ? String(row.last_error) : undefined,
      metadata: parseObject(String(row.metadata_json ?? "{}")),
    };
  }
}
