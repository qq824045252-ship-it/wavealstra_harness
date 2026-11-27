import type Database from "better-sqlite3";
import { TaskWriteQueue } from "../db/TaskWriteQueue";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type {
  ConversationInteractionAnswer,
  ConversationInteractionDto,
  ConversationInteractionKind,
  ConversationInteractionOption,
  ConversationInteractionStatus,
} from "../../shared/conversation-interaction";

export type RuntimeConversationInteractionRow = {
  id: string; task_id: string; execution_id: string; assistant_message_id: string;
  kind: ConversationInteractionKind; title: string; description: string | null; options_json: string;
  min_selections: number | null; max_selections: number | null; allow_custom: number;
  custom_placeholder: string | null; status: ConversationInteractionStatus; answer_json: string | null;
  version: number; created_at: number; resolved_at: number | null;
};

type Row = RuntimeConversationInteractionRow;

export class ConversationInteractionRepository {
  private readonly writes = new TaskWriteQueue();

  constructor(
    private readonly fixture: Database.Database | undefined,
    private readonly reader?: import("../platform/runtime-audit").RuntimeAuditReader,
  ) {}

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("对话交互记录需要通过 Rust Core 读取或写入");
    return this.fixture;
  }

  flush(taskId?: string): Promise<void> {
    return this.writes.flush(taskId);
  }

  private get rustRequired(): boolean {
    return !this.fixture || Boolean(this.fixture.readonly || this.reader?.supervised);
  }

  private enqueueRustWrite(request: Record<string, unknown> & { taskId?: string }): void {
    void this.writeRust(request).catch(error => {
      console.warn(`[ConversationInteractions] Rust write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private writeRust<T>(request: Record<string, unknown> & { taskId?: string }): Promise<T> {
    const reader = this.reader;
    if (!reader) throw new Error("ConversationInteractionRepository 缺少 Rust 写入通道");
    const write = async () => {
      const reply = await reader.batch1Write<T>(request);
      if (reply === undefined) throw new Error(`交互状态写入未获 Rust 确认: ${String(request.kind)}`);
      return reply;
    };
    return request.taskId === undefined ? this.writes.runExclusive(write) : this.writes.run([request.taskId], write);
  }

  insert(value: ConversationInteractionDto): ConversationInteractionDto {
    const optionsJson = JSON.stringify(value.options);
    const answerJson = value.answer === undefined ? null : JSON.stringify(value.answer);
    if (this.reader && this.rustRequired) {
      this.enqueueRustWrite({
        kind: "interactionInsert",
        id: value.id,
        taskId: value.taskId,
        executionId: value.executionId,
        assistantMessageId: value.assistantMessageId,
        kindName: value.kind,
        title: value.title,
        description: value.description ?? null,
        optionsJson,
        minSelections: value.minSelections ?? null,
        maxSelections: value.maxSelections ?? null,
        allowCustom: value.allowCustom ? 1 : 0,
        customPlaceholder: value.customPlaceholder ?? null,
        status: value.status,
        answerJson,
        version: value.version,
        createdAt: value.createdAt,
        resolvedAt: value.resolvedAt ?? null,
      });
      return { ...value };
    }
    if (this.db.readonly) throw new Error("只读数据库模式下无法写入 conversation_interactions");
    this.db.prepare(`INSERT INTO conversation_interactions
      (id,task_id,execution_id,assistant_message_id,kind,title,description,options_json,min_selections,
       max_selections,allow_custom,custom_placeholder,status,answer_json,version,created_at,resolved_at)
      VALUES (@id,@taskId,@executionId,@assistantMessageId,@kind,@title,@description,@optionsJson,@minSelections,
       @maxSelections,@allowCustom,@customPlaceholder,@status,@answerJson,@version,@createdAt,@resolvedAt)`).run({
      ...value,
      description: value.description ?? null,
      optionsJson,
      minSelections: value.minSelections ?? null,
      maxSelections: value.maxSelections ?? null,
      allowCustom: value.allowCustom ? 1 : 0,
      customPlaceholder: value.customPlaceholder ?? null,
      answerJson,
      resolvedAt: value.resolvedAt ?? null,
    });
    return this.get(value.id)!;
  }

  get(id: string): ConversationInteractionDto | undefined {
    const row = this.db.prepare("SELECT * FROM conversation_interactions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapConversationInteraction(row) : undefined;
  }

  listByTask(taskId: string): ConversationInteractionDto[] {
    return (this.db.prepare(
      "SELECT * FROM conversation_interactions WHERE task_id=? ORDER BY created_at ASC, rowid ASC",
    ).all(taskId) as Row[]).map(mapConversationInteraction);
  }

  deleteFrom(taskId: string, createdAt: number): number {
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM conversation_interactions WHERE task_id=? AND created_at>=?")
      .get(taskId, createdAt) as { n: number }).n;
    if (this.reader && this.rustRequired) {
      this.enqueueRustWrite({ kind: "interactionDeleteFrom", taskId, createdAt });
      return count;
    }
    if (this.db.readonly) throw new Error("只读数据库模式下无法删除 conversation_interactions");
    return this.db.prepare("DELETE FROM conversation_interactions WHERE task_id=? AND created_at>=?")
      .run(taskId, createdAt).changes;
  }

  settle(id: string, status: Exclude<ConversationInteractionStatus, "pending">, answer?: ConversationInteractionAnswer): ConversationInteractionDto | undefined {
    const now = Date.now();
    const answerJson = answer === undefined ? null : JSON.stringify(answer);
    if (this.reader && this.rustRequired) {
      const current = this.get(id);
      if (!current || current.status !== "pending") return undefined;
      this.enqueueRustWrite({ kind: "interactionSettle", id, taskId: current.taskId, status, answerJson, resolvedAt: now });
      return { ...current, status, answer, version: current.version + 1, resolvedAt: now };
    }
    if (this.db.readonly) throw new Error("只读数据库模式下无法更新 conversation_interactions");
    const result = this.db.prepare(`UPDATE conversation_interactions
      SET status=?, answer_json=?, version=version+1, resolved_at=? WHERE id=? AND status='pending'`)
      .run(status, answerJson, now, id);
    return result.changes > 0 ? this.get(id) : undefined;
  }

  async cancelForTask(taskId: string, id: string): Promise<ConversationInteractionDto | undefined> {
    if (!this.rustRequired) return this.get(id)?.taskId === taskId ? this.settle(id, "cancelled") : undefined;
    const reply = await this.writeRust<{ row: Row | null }>({
      kind: "interactionSettle", taskId, id, status: "cancelled", answerJson: null, resolvedAt: Date.now(),
    });
    return reply.row ? mapConversationInteraction(reply.row) : undefined;
  }

  async cancelPendingInExecution(context: ConversationExecutionContext): Promise<ConversationInteractionDto[]> {
    if (!this.rustRequired) return this.listPendingByExecution(context.executionId).flatMap(pending => {
      if (pending.taskId !== context.taskId || pending.assistantMessageId !== context.assistantMessageId) return [];
      const cancelled = this.settle(pending.id, "cancelled");
      return cancelled ? [cancelled] : [];
    });
    const reply = await this.writeRust<{ rows: Row[] }>({ kind: "interactionCancelExecution", ...context, resolvedAt: Date.now() });
    return reply.rows.map(mapConversationInteraction);
  }

  pendingByExecution(executionId: string): ConversationInteractionDto | undefined {
    const row = this.db.prepare(
      "SELECT * FROM conversation_interactions WHERE execution_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
    ).get(executionId) as Row | undefined;
    return row ? mapConversationInteraction(row) : undefined;
  }

  listPendingByExecution(executionId: string): ConversationInteractionDto[] {
    return (this.db.prepare("SELECT * FROM conversation_interactions WHERE execution_id=? AND status='pending' ORDER BY created_at, rowid")
      .all(executionId) as Row[]).map(mapConversationInteraction);
  }

  expireAllPending(): ConversationInteractionDto[] {
    const rows = this.db.prepare("SELECT * FROM conversation_interactions WHERE status='pending'").all() as Row[];
    const now = Date.now();
    if (this.reader && this.rustRequired) {
      this.enqueueRustWrite({ kind: "interactionExpireAllPending", resolvedAt: now });
      return rows.map((row) => ({ ...mapConversationInteraction(row), status: "expired" as const, version: row.version + 1, resolvedAt: now }));
    }
    if (this.db.readonly) throw new Error("只读数据库模式下无法更新 conversation_interactions");
    const settle = this.db.prepare(
      "UPDATE conversation_interactions SET status='expired', version=version+1, resolved_at=? WHERE id=? AND status='pending'",
    );
    this.db.transaction(() => rows.forEach((row) => settle.run(now, row.id)))();
    return rows.map((row) => this.get(row.id)!).filter(Boolean);
  }
}

export function mapConversationInteraction(row: RuntimeConversationInteractionRow): ConversationInteractionDto {
  return {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id,
    assistantMessageId: row.assistant_message_id,
    kind: row.kind,
    title: row.title,
    description: row.description ?? undefined,
    options: JSON.parse(row.options_json) as ConversationInteractionOption[],
    minSelections: row.min_selections ?? undefined,
    maxSelections: row.max_selections ?? undefined,
    allowCustom: row.allow_custom === 1,
    customPlaceholder: row.custom_placeholder ?? undefined,
    status: row.status,
    answer: row.answer_json === null ? undefined : JSON.parse(row.answer_json) as ConversationInteractionAnswer,
    version: row.version,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}
