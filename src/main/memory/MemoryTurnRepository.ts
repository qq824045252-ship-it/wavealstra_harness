import { botMemorySource, readBotMemorySource } from "./BotMemorySource";
import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import { LOCAL_USER_ID } from "../../shared/bot-work";
import { RuntimeAuditUnknownOperationError } from "../platform/runtime-audit";
import type { CoreMemoryExtractionPlan, RuntimeMemoryExtractionBasis, RuntimeMemoryExtractionBasisRequest,
  RuntimeMemoryExtractionPublish, RuntimeMemoryExtractionPublishReply } from "./MemoryCoreExtractionWire";
import type { MemoryPipelineStateDto, MemorySkillLearningStatusDto, MemoryTurnDto, MemoryTurnExtractionState, MemoryTurnListRequest, MemoryTurnTaskDto } from "../../shared/memory-kernel";

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

type PreparedTurn = Omit<CaptureMemoryTurnInput, "metadata" | "capturedAt"> & {
  id: string;
  capturedAt: number;
  metadataJson: string;
};

export type RuntimeMemoryCapture =
  | { kind: "turn"; turn: PreparedTurn }
  | { kind: "durable"; taskId: string; entries: Array<{ entryId: number; turn?: PreparedTurn }> };

export type DurableMemoryTurn = CaptureMemoryTurnInput & { entryId: number; skipCapture?: boolean };

export type RuntimeMemoryTurnQuery =
  | ({ kind: "list"; limit: number } & Omit<MemoryTurnListRequest, "limit">)
  | { kind: "detail"; id: string }
  | { kind: "hasPending"; taskId: string }
  | ({ kind: "extractionCurrent" } & MemoryExtractionLease)
  | (RuntimeMemoryExtractionBasisRequest & MemoryExtractionLease)
  | { kind: "tasks" }
  | { kind: "skillLearningStatus" }
  | { kind: "undistilledTurns" };

type RuntimeMemoryTurnRow = Omit<MemoryTurnDto, "metadata"> & { metadataJson: string };
type SkillLearningCounts = Omit<MemorySkillLearningStatusDto, "distillation" | "blockedSkills">;

export type RuntimeMemoryTurnData =
  | { kind: "list"; turns: RuntimeMemoryTurnRow[] }
  | { kind: "detail"; turn: RuntimeMemoryTurnRow | null }
  | { kind: "hasPending"; pending: boolean }
  | { kind: "extractionCurrent"; current: boolean }
  | RuntimeMemoryExtractionBasis
  | { kind: "tasks"; tasks: MemoryTurnTaskDto[] }
  | ({ kind: "skillLearningStatus"; latestError: string | null } & Omit<SkillLearningCounts, "latestError">)
  | { kind: "undistilledTurns"; rows: Array<{ id: string; taskId: string; userText: string; assistantText: string }> };

function projectRuntimeTurn({ metadataJson, ...turn }: RuntimeMemoryTurnRow): MemoryTurnDto {
  return { ...turn, metadata: parseObject(metadataJson) };
}

export type MemoryExtractionLease = { taskId: string; owner: string; token: string };
export interface MemoryExtractionSnapshot { taskIds: string[]; capturedThrough: number; sourceIdsByTask: Record<string, string[]> }
export interface MemoryExtractionRetry extends MemoryExtractionSnapshot { reset: number }
export type RuntimeMemoryTurnExtractionCommand = MemoryExtractionLease & (
  | { kind: "claim"; capturedThrough: number; capturedRowId?: number; sourceIds?: readonly string[]; limit: number; leaseMs?: number }
  | { kind: "renew"; leaseMs?: number }
  | { kind: "settle"; disposition: "completed" | "failed" | "release"; error?: string }
  | RuntimeMemoryExtractionPublish
);
type ExtractionClaim<Row> = { status: "claimed"; turns: Row[]; leaseExpiresAt: number }
  | { status: "busy"; leaseExpiresAt: number }
  | { status: "empty" | "stale" | "ineligible" };
export type RuntimeMemoryTurnExtractionReply = ExtractionClaim<RuntimeMemoryTurnRow>
  | { status: "renewed"; leaseExpiresAt: number }
  | { status: "completed" | "failed" | "released" }
  | RuntimeMemoryExtractionPublishReply;

export function prepareMemoryTurn(input: CaptureMemoryTurnInput): PreparedTurn {
  return {
    id: `mturn_${randomUUID()}`, taskId: input.taskId, sessionId: input.sessionId,
    userMessageId: input.userMessageId, assistantMessageId: input.assistantMessageId,
    userText: input.userText, assistantText: input.assistantText, capturedAt: input.capturedAt ?? Date.now(),
    metadataJson: JSON.stringify(input.metadata ?? {}),
  };
}

export class MemoryTurnRepository {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly db: AppDatabase) {}
  private get conn() { return this.db.connection; }

  private get requiresRustWrites(): boolean {
    return Boolean(this.db.readonly || this.db.runtimeAuditReader?.supervised);
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  private enqueueBatch3(context: string, request: Record<string, unknown>): void {
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error(`${context}：Rust 写入核心未就绪`);
    const next = this.writeTail.then(async () => {
      const result = await reader.batch3Write(request);
      if (result === undefined) throw new Error(`${context}：Rust 写入未收到确认`);
    });
    this.writeTail = next.then(() => undefined, () => undefined);
  }

  capture(input: CaptureMemoryTurnInput): { turn: MemoryTurnDto; created: boolean } {
    const prepared = prepareMemoryTurn(input);
    if (this.requiresRustWrites) {
      const userText = prepared.userText.trim();
      const assistantText = prepared.assistantText.trim();
      const contentHash = hashTurn(userText, assistantText);
      const existing = (prepared.assistantMessageId
        ? this.conn.prepare("SELECT id FROM memory_turns WHERE assistant_message_id=?").get(prepared.assistantMessageId)
        : this.conn.prepare("SELECT id FROM memory_turns WHERE task_id=? AND content_hash=? ORDER BY captured_at DESC LIMIT 1")
          .get(prepared.taskId, contentHash)) as { id: string } | undefined;
      if (existing) {
        const turn = this.get(existing.id) ?? this.mapTurn(this.conn.prepare("SELECT * FROM memory_turns WHERE id=?").get(existing.id) as Record<string, unknown>);
        return { turn, created: false };
      }
      this.enqueueBatch3("捕获记忆轮次", {
        kind: "memoryTurnCapture",
        turn: {
          id: prepared.id,
          taskId: prepared.taskId,
          sessionId: prepared.sessionId ?? null,
          userMessageId: prepared.userMessageId ?? null,
          assistantMessageId: prepared.assistantMessageId ?? null,
          userText,
          assistantText,
          contentHash,
          capturedAt: prepared.capturedAt,
          metadataJson: prepared.metadataJson,
        },
        noteCaptured: false,
        now: Date.now(),
      });
      return {
        turn: {
          id: prepared.id,
          taskId: prepared.taskId,
          sessionId: prepared.sessionId,
          userMessageId: prepared.userMessageId,
          assistantMessageId: prepared.assistantMessageId,
          userText,
          assistantText,
          contentHash,
          capturedAt: prepared.capturedAt,
          extractionState: "pending",
          attemptCount: 0,
          metadata: JSON.parse(prepared.metadataJson) as Record<string, unknown>,
        },
        created: true,
      };
    }
    return this.conn.transaction(() => {
      const { id, created } = this.insertTurn(prepared);
      const turn = created ? this.get(id) : this.mapTurn(this.conn.prepare("SELECT * FROM memory_turns WHERE id=?").get(id) as Record<string, unknown>);
      return { turn: turn!, created };
    }).immediate();
  }

  captureCompletedOnHost(capture: RuntimeMemoryCapture): number {
    if (this.requiresRustWrites) {
      throw new Error("保存完成轮次记忆无法回退到宿主 SQLite");
    }
    return this.conn.transaction(() => {
      const save = (turn: PreparedTurn): number => {
        const { id, created } = this.insertTurn(turn);
        if (created) this.updateCaptureCount(turn.taskId, turn.capturedAt);
        return Number(id === turn.id);
      };
      if (capture.kind === "turn") return save(capture.turn);
      const { taskId, entries } = capture;
      const prior = (this.conn.prepare("SELECT entry_id FROM durable_bot_memory_projection WHERE task_id=?")
        .get(taskId) as { entry_id: number } | undefined)?.entry_id ?? 0;
      let through = prior;
      let saved = 0;
      for (const { entryId, turn } of entries) {
        if (entryId <= prior) continue;
        through = Math.max(through, entryId);
        if (turn) {
          if (turn.taskId !== taskId) throw new Error("Memory turn does not belong to the projection task");
          saved += save(turn);
        }
      }
      if (through > prior) {
        this.conn.prepare(`INSERT INTO durable_bot_memory_projection(task_id,entry_id) VALUES (?,?)
          ON CONFLICT(task_id) DO UPDATE SET entry_id=excluded.entry_id`).run(taskId, through);
      }
      return saved;
    }).immediate();
  }

  private insertTurn(input: PreparedTurn): { id: string; created: boolean } {
    const { id, capturedAt } = input;
    const userText = input.userText.trim();
    const assistantText = input.assistantText.trim();
    const contentHash = hashTurn(userText, assistantText);
    const existing = (input.assistantMessageId
      ? this.conn.prepare("SELECT id FROM memory_turns WHERE assistant_message_id=?").get(input.assistantMessageId)
      : this.conn.prepare("SELECT id FROM memory_turns WHERE task_id=? AND content_hash=? ORDER BY captured_at DESC LIMIT 1")
        .get(input.taskId, contentHash)) as { id: string } | undefined;
    if (existing) return { id: existing.id, created: false };

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
      input.metadataJson,
    );
    return { id, created: true };
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
      // 同毫秒用 rowid 兜底（id 是随机 UUID，不能作为时序兜底）。
      "SELECT * FROM memory_turns WHERE task_id=? ORDER BY captured_at DESC,rowid DESC LIMIT ?",
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
      ORDER BY captured_at,rowid
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
      ${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY captured_at DESC,m.rowid DESC LIMIT ?`;
    return (this.conn.prepare(sql).all(...args) as Array<Record<string, unknown>>).map((row) => this.mapTurn(row));
  }

  async readList(request: MemoryTurnListRequest = {}): Promise<MemoryTurnDto[]> {
    const limit = Math.max(1, Math.min(2000, request.limit ?? 300));
    if (Number.isSafeInteger(limit)) {
      const data = await this.db.runtimeAuditReader?.memoryTurnData({
        kind: "list", limit, taskId: request.taskId?.trim(), extractionState: request.extractionState,
        query: request.query?.trim(),
      }, LOCAL_USER_ID);
      if (data?.kind === "list") return data.turns.map(projectRuntimeTurn);
    }
    if (!this.db.fixtureConnection) throw new Error("Core 未确认对话来源列表");
    return this.list(request);
  }

  async readDetail(id: string): Promise<MemoryTurnDto | undefined> {
    const data = await this.db.runtimeAuditReader?.memoryTurnData({ kind: "detail", id }, LOCAL_USER_ID);
    if (data?.kind === "detail") return data.turn ? projectRuntimeTurn(data.turn) : undefined;
    if (!this.db.fixtureConnection) throw new Error("Core 未确认对话来源读取");
    return this.get(id);
  }

  /**
   * 待抽取队列：按捕获时间升序，**同毫秒用 rowid（插入顺序）兜底**。
   *
   * 曾经用 `captured_at ASC,id ASC`，而 id 是 `mturn_${randomUUID()}` —— 同一毫秒内捕获的
   * 两条 turn 只能靠随机 UUID 决胜负，批量抽取时 turn 顺序会随运行变化（记忆抽取拿到
   * 的证据顺序不稳，用例也会偶发红）。rowid 单调递增且稳定，才是"插入顺序"的正确兜底。
   */
  listPending(taskId: string, limit = 8, capturedThrough = Number.MAX_SAFE_INTEGER): MemoryTurnDto[] {
    return (this.conn.prepare(
      `SELECT * FROM memory_turns
       WHERE task_id=? AND extraction_state IN ('pending','failed') AND attempt_count < 3 AND captured_at<=?
       ORDER BY captured_at ASC,rowid ASC LIMIT ?`,
    ).all(taskId, capturedThrough, Math.max(1, Math.min(50, limit))) as Array<Record<string, unknown>>).map((row) => this.mapTurn(row));
  }

  /** Recovery only needs a witness. Extraction must still claim a batch through its writer. */
  async hasPending(taskId: string): Promise<boolean> {
    if (this.db.fixtureConnection) return this.listPending(taskId, 1).length > 0;
    const reader = this.db.runtimeAuditReader;
    if (!reader || !taskId.trim()) throw new Error("Core 记忆提炼恢复查询尚未就绪");
    const result = await reader.memoryTurnData({ kind: "hasPending", taskId }, LOCAL_USER_ID);
    if (result?.kind !== "hasPending") throw new Error("Core 未能确认原任务是否还有可重试的记忆轮次");
    return result.pending;
  }

  async claimExtraction(lease: MemoryExtractionLease, options: { capturedThrough: number; capturedRowId?: number; sourceIds?: readonly string[]; limit: number; leaseMs?: number }): Promise<ExtractionClaim<MemoryTurnDto>> {
    const reply = await this.writeExtraction({ ...lease, ...options, kind: "claim" });
    switch (reply.status) {
      case "claimed": return { ...reply, turns: reply.turns.map(projectRuntimeTurn) };
      case "empty": case "busy": case "stale": case "ineligible": return reply;
      default: throw new Error("Core 返回了无效的记忆提炼认领回执");
    }
  }

  async renewExtraction(lease: MemoryExtractionLease, leaseMs?: number): Promise<number | undefined> {
    const reply = await this.writeExtraction({ ...lease, kind: "renew", leaseMs });
    if (reply.status === "renewed") return reply.leaseExpiresAt;
    if (reply.status !== "stale") throw new Error("Core 返回了无效的记忆提炼续期回执");
  }

  async settleExtraction(lease: MemoryExtractionLease, disposition: "completed" | "failed" | "release", error?: string) {
    const reply = await this.writeExtraction({ ...lease, kind: "settle", disposition, error });
    switch (reply.status) {
      case "completed": case "failed": case "released": case "stale": return reply.status;
      default: throw new Error("Core 返回了无效的记忆提炼结算回执");
    }
  }

  async extractionCurrent(lease: MemoryExtractionLease): Promise<boolean> {
    const data = await this.db.runtimeAuditReader?.memoryTurnData({ ...lease, kind: "extractionCurrent" }, LOCAL_USER_ID);
    if (data?.kind !== "extractionCurrent") throw new Error("Core 未确认原记忆提炼是否有效");
    return data.current;
  }

  async extractionBasis(lease: MemoryExtractionLease): Promise<RuntimeMemoryExtractionBasis> {
    const data = await this.db.runtimeAuditReader?.memoryTurnData({ ...lease, kind: "extractionBasis" }, LOCAL_USER_ID);
    if (data?.kind !== "extractionBasis") throw new Error("Core 未确认记忆提炼原文和范围");
    return data;
  }

  async publishExtraction(lease: MemoryExtractionLease, plan: CoreMemoryExtractionPlan): Promise<RuntimeMemoryExtractionPublishReply> {
    const reply = await this.writeExtraction({ ...lease, ...plan, kind: "publish" });
    switch (reply.status) {
      case "published": case "filtered": case "blocked": case "conflict": return reply;
      case "stale": return { status: "stale" };
      default: throw new Error("Core 返回了无效的记忆提炼发布回执");
    }
  }

  async readExtractionQueue(taskIds?: readonly string[]): Promise<MemoryExtractionSnapshot> {
    const snapshot = await this.db.runtimeAuditReader?.readMemoryExtractionQueue(taskIds);
    if (!snapshot) throw new Error("Core 未确认待提炼记忆轮次");
    return snapshot;
  }

  async retryExtractionQueue(): Promise<MemoryExtractionRetry> {
    const reader = this.db.runtimeAuditReader;
    if (!reader?.supervised) throw new Error("重试提炼需要 Rust Core");
    const operationId = randomUUID();
    const write = () => reader.retryMemoryExtractionQueue(LOCAL_USER_ID, operationId);
    const result = await write().catch(error => {
      if (error instanceof RuntimeAuditUnknownOperationError) return write();
      throw error;
    });
    if (!result) throw new Error("Core 未确认记忆提炼重试");
    return result;
  }

  async deleteCaptured(ids?: readonly string[]): Promise<number> {
    if (this.db.fixtureConnection) return ids ? this.deleteMany(ids) : this.deleteAll();
    if (ids?.length === 0) return 0;
    const result = await this.db.runtimeAuditReader?.batch3Write<{ deleted: number }>({
      kind: "memoryTurnDelete", deleteAll: ids === undefined, ids: ids ? [...new Set(ids)] : [], now: Date.now(),
    });
    if (!result) throw new Error("Core 未确认对话来源删除");
    return result.deleted;
  }

  private async writeExtraction(command: RuntimeMemoryTurnExtractionCommand): Promise<RuntimeMemoryTurnExtractionReply> {
    const reader = this.db.runtimeAuditReader;
    if (!reader?.supervised) throw new Error("持有者认领需要 Rust Core");
    const write = () => reader.writeMemoryTurnExtraction(command, LOCAL_USER_ID);
    const result = await write().catch(error => {
      if (error instanceof RuntimeAuditUnknownOperationError) return write();
      throw error;
    });
    if (!result) throw new Error("Core 未确认记忆提炼状态写入");
    return result;
  }

  canExtractTask(taskId: string): boolean {
    const bot = botMemorySource(this.db, taskId);
    if (bot) return bot.status === "active";
    const task = this.db.getTask(taskId);
    if (!task || this.db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") return false;
    if (task.projectId) {
      const project = this.conn.prepare("SELECT archived FROM projects WHERE id=?").get(task.projectId) as { archived: number } | undefined;
      if (!project || project.archived) return false;
    }
    return true;
  }

  async canExtractTaskAsync(taskId: string): Promise<boolean> {
    if (!this.db.coreIdentity) return this.canExtractTask(taskId);
    const bot = await readBotMemorySource(this.db, taskId);
    if (bot) return bot.status === "active";
    const [task, wsState] = await Promise.all([
      this.db.readTask(taskId, { includeExpertBinding: false }),
      this.db.readTaskExecutionWorkspaceState(taskId),
    ]);
    if (!task || wsState?.state === "trashed") return false;
    if (task.projectId) {
      const res = await this.db.runtimeAuditReader?.memoryRecordsData({ kind: "projects", includeArchived: true });
      const project = res?.kind === "projects" ? res.projects.find(p => p.id === task.projectId) : undefined;
      if (!project || project.archived) return false;
    }
    return true;
  }

  async allExistAsync(ids: readonly string[]): Promise<boolean> {
    if (!this.db.coreIdentity) return this.allExist(ids);
    if (!ids.length) return true;
    const items = await Promise.all(ids.map(id => this.readDetail(id)));
    return items.every(Boolean);
  }

  async readUndistilledTurns(limit = 2000): Promise<Array<{ id: string; taskId: string }>> {
    if (!this.db.coreIdentity) return [];
    const data = await this.db.runtimeAuditReader?.memoryTurnData({ kind: "undistilledTurns" }, LOCAL_USER_ID);
    if (data?.kind !== "undistilledTurns") return [];
    return data.rows.slice(0, limit).map(row => ({ id: row.id, taskId: row.taskId }));
  }

  async readSkillLearningCounts(): Promise<SkillLearningCounts> {
    const data = await this.db.runtimeAuditReader?.memoryTurnData({ kind: "skillLearningStatus" }, LOCAL_USER_ID);
    if (data?.kind === "skillLearningStatus") {
      const { kind: _kind, latestError, ...counts } = data;
      return { ...counts, latestError: latestError?.slice(0, 200) };
    }
    if (!this.db.fixtureConnection) throw new Error("Core 未确认记忆学习状态");

    return this.conn.transaction(() => {
      const procedures = this.conn.prepare(`SELECT COUNT(*) AS procedures, COUNT(*) FILTER (
          WHERE EXISTS(SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND s.scope_type<>'task')
        ) AS reusableProcedures FROM (
          SELECT id FROM memory_records WHERE kind='procedure' AND status='active'
          ORDER BY updated_at DESC,id DESC LIMIT 2000
        ) m`).get() as Pick<SkillLearningCounts, "procedures" | "reusableProcedures">;
      const rows = this.conn.prepare(`SELECT task_id,
          COUNT(*) FILTER (WHERE extraction_state='failed') AS failed,
          COUNT(*) FILTER (WHERE extraction_state='pending' OR attempt_count<3) AS pending
        FROM memory_turns WHERE extraction_state IN ('pending','failed') GROUP BY task_id`)
        .all() as Array<{ task_id: string; failed: number; pending: number }>;
      const latest = this.conn.prepare(`SELECT last_error FROM memory_turns WHERE extraction_state='failed'
        ORDER BY captured_at DESC LIMIT 1`).get() as { last_error: string | null } | undefined;
      let failedTurns = 0;
      let retryableFailedTurns = 0;
      let pendingTurns = 0;
      for (const row of rows) {
        failedTurns += row.failed;
        if (!this.canExtractTask(row.task_id)) continue;
        retryableFailedTurns += row.failed;
        pendingTurns += row.pending;
      }
      return { ...procedures, failedTurns, retryableFailedTurns, pendingTurns, latestError: latest?.last_error?.slice(0, 200) };
    })();
  }

  listTaskOptions(): MemoryTurnTaskDto[] {
    return (this.conn.prepare(`SELECT DISTINCT m.task_id,t.title,w.state FROM memory_turns m
      LEFT JOIN tasks t ON t.id=m.task_id LEFT JOIN task_execution_workspace_state w ON w.task_id=m.task_id
      ORDER BY t.title,m.task_id`).all() as Array<{ task_id: string; title: string | null; state: string | null }>).map((row) => ({
      id: row.task_id, title: row.title || (botMemorySource(this.db, row.task_id) ? "Bot 对话" : "原任务已删除"), trashed: row.state === "trashed",
    }));
  }

  async readTaskOptions(): Promise<MemoryTurnTaskDto[]> {
    const data = await this.db.runtimeAuditReader?.memoryTurnData({ kind: "tasks" }, LOCAL_USER_ID);
    if (data?.kind === "tasks") return data.tasks;
    if (!this.db.fixtureConnection) throw new Error("Core 未确认对话来源所属任务");
    return this.listTaskOptions();
  }

  pendingTaskIds(): string[] {
    return (this.conn.prepare(`SELECT DISTINCT task_id FROM memory_turns
      WHERE extraction_state IN ('pending','failed') AND attempt_count < 3`).all() as Array<{ task_id: string }>).map((row) => row.task_id);
  }

  /** Remove all captured originals, keeping the bounded evidence owned by durable memories. */
  deleteAll(): number {
    if (this.requiresRustWrites) {
      const total = this.countByState();
      if (total > 0) {
        this.enqueueBatch3("清空捕获轮次", {
          kind: "memoryTurnDelete",
          deleteAll: true,
          ids: [],
          now: Date.now(),
        });
      }
      return total;
    }
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
    if (this.requiresRustWrites) {
      const existing = unique.filter((id) => Boolean(this.conn.prepare("SELECT 1 FROM memory_turns WHERE id=?").get(id)));
      if (existing.length > 0) {
        this.enqueueBatch3("批量删除捕获轮次", {
          kind: "memoryTurnDelete",
          deleteAll: false,
          ids: existing,
          now: Date.now(),
        });
      }
      return existing.length;
    }
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
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return;
    if (this.requiresRustWrites) {
      this.enqueueBatch3("重排记忆轮次", {
        kind: "memoryTurnUpdateState",
        stateAction: "requeue",
        ids: unique,
        now: Date.now(),
        error: null,
        taskId: null,
        remainingPending: null,
      });
      return;
    }
    const reset = this.conn.prepare(`UPDATE memory_turns
      SET extraction_state='pending',attempt_count=MAX(0,attempt_count-1),last_error=NULL
      WHERE id=? AND extraction_state='processing'`);
    this.conn.transaction(() => { for (const id of unique) reset.run(id); })();
  }

  markProcessing(ids: readonly string[]): void {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return;
    if (this.requiresRustWrites) {
      this.enqueueBatch3("标记记忆提取中", {
        kind: "memoryTurnUpdateState",
        stateAction: "processing",
        ids: unique,
        now: Date.now(),
        error: null,
        taskId: null,
        remainingPending: null,
      });
      return;
    }
    const stmt = this.conn.prepare(
      "UPDATE memory_turns SET extraction_state='processing',attempt_count=attempt_count+1,last_error=NULL WHERE id=?",
    );
    this.conn.transaction(() => { for (const id of unique) stmt.run(id); })();
  }

  markCompleted(ids: readonly string[], now = Date.now()): void {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return;
    if (this.requiresRustWrites) {
      this.enqueueBatch3("标记记忆提取完成", {
        kind: "memoryTurnUpdateState",
        stateAction: "completed",
        ids: unique,
        now,
        error: null,
        taskId: null,
        remainingPending: null,
      });
      return;
    }
    const stmt = this.conn.prepare(
      "UPDATE memory_turns SET extraction_state='completed',extracted_at=?,last_error=NULL WHERE id=?",
    );
    this.conn.transaction(() => { for (const id of unique) stmt.run(now, id); })();
  }

  markFailed(ids: readonly string[], error: unknown): void {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    if (this.requiresRustWrites) {
      this.enqueueBatch3("标记记忆提取失败", {
        kind: "memoryTurnUpdateState",
        stateAction: "failed",
        ids: unique,
        now: Date.now(),
        error: message,
        taskId: null,
        remainingPending: null,
      });
      return;
    }
    const stmt = this.conn.prepare(
      "UPDATE memory_turns SET extraction_state='failed',last_error=? WHERE id=?",
    );
    this.conn.transaction(() => { for (const id of unique) stmt.run(message, id); })();
  }

  markSkillDistilled(ids: readonly string[]): void {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return;
    if (this.requiresRustWrites) {
      this.enqueueBatch3("标记技能提炼已检查", {
        kind: "memoryTurnUpdateState",
        stateAction: "skillDistilled",
        ids: unique,
        now: Date.now(),
        error: null,
        taskId: null,
        remainingPending: null,
      });
      return;
    }
    const stmt = this.conn.prepare(
      "UPDATE memory_turns SET metadata_json=json_set(metadata_json,'$.skillDistilled',1) WHERE id=?",
    );
    this.conn.transaction(() => { for (const id of unique) stmt.run(id); })();
  }

  /** Failed turns become pending again with a fresh attempt budget; caller may drive extraction via the returned task ids. */
  resetFailedTurns(): { reset: number; taskIds: string[] } {
    const rows = this.conn.prepare(
      "SELECT id, task_id FROM memory_turns WHERE extraction_state='failed'",
    ).all() as Array<{ id: string; task_id: string }>;
    const eligible = rows.filter((row) => this.canExtractTask(row.task_id));
    if (eligible.length === 0) return { reset: 0, taskIds: [] };
    if (this.requiresRustWrites) {
      this.enqueueBatch3("重置失败轮次", {
        kind: "memoryResetFailedTurns",
        eligibleIds: eligible.map((row) => row.id),
      });
      return { reset: eligible.length, taskIds: [...new Set(eligible.map((row) => row.task_id))] };
    }
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
    if (this.requiresRustWrites) {
      this.enqueueBatch3("记录记忆捕获计数", {
        kind: "memoryTurnUpdateState",
        stateAction: "noteCaptured",
        ids: [],
        now,
        error: null,
        taskId,
        remainingPending: null,
      });
      const current = this.getPipelineState(taskId);
      return {
        ...current,
        capturedTurns: current.capturedTurns + 1,
        turnsSinceL1: current.turnsSinceL1 + 1,
        updatedAt: now,
      };
    }
    this.updateCaptureCount(taskId, now);
    return this.getPipelineState(taskId);
  }

  private updateCaptureCount(taskId: string, now: number): void {
    this.conn.prepare(
      `INSERT INTO memory_pipeline_state (
        task_id,captured_turns,turns_since_l1,last_l1_at,last_l2_at,last_l3_at,l1_run_count,l2_run_count,l3_run_count,updated_at
      ) VALUES (?,1,1,NULL,NULL,NULL,0,0,0,?)
      ON CONFLICT(task_id) DO UPDATE SET
        captured_turns=captured_turns+1,
        turns_since_l1=turns_since_l1+1,
        updated_at=excluded.updated_at`,
    ).run(taskId, now);
  }

  noteL1Completed(taskId: string, remainingPending = 0, now = Date.now()): MemoryPipelineStateDto {
    const remaining = Math.max(0, remainingPending);
    if (this.requiresRustWrites) {
      this.enqueueBatch3("更新记忆 L1 完成状态", {
        kind: "memoryTurnUpdateState",
        stateAction: "noteL1Completed",
        ids: [],
        now,
        error: null,
        taskId,
        remainingPending: remaining,
      });
      const current = this.getPipelineState(taskId);
      return {
        ...current,
        turnsSinceL1: remaining,
        lastL1At: now,
        l1RunCount: current.l1RunCount + 1,
        updatedAt: now,
      };
    }
    this.conn.prepare(
      `INSERT INTO memory_pipeline_state (
        task_id,captured_turns,turns_since_l1,last_l1_at,last_l2_at,last_l3_at,l1_run_count,l2_run_count,l3_run_count,updated_at
      ) VALUES (?,0,?,?,NULL,NULL,1,0,0,?)
      ON CONFLICT(task_id) DO UPDATE SET
        turns_since_l1=excluded.turns_since_l1,last_l1_at=excluded.last_l1_at,l1_run_count=l1_run_count+1,updated_at=excluded.updated_at`,
    ).run(taskId, remaining, now, now);
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
      taskTitle: row.task_title ? String(row.task_title) : botMemorySource(this.db, String(row.task_id)) ? "Bot 对话" : undefined,
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
