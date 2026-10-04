import type Database from "better-sqlite3";
import type {
  ConversationInteractionAnswer,
  ConversationInteractionDto,
  ConversationInteractionKind,
  ConversationInteractionOption,
  ConversationInteractionStatus,
} from "../../shared/conversation-interaction";

type Row = {
  id: string; task_id: string; execution_id: string; assistant_message_id: string;
  kind: ConversationInteractionKind; title: string; description: string | null; options_json: string;
  min_selections: number | null; max_selections: number | null; allow_custom: number;
  custom_placeholder: string | null; status: ConversationInteractionStatus; answer_json: string | null;
  version: number; created_at: number; resolved_at: number | null;
};

export class ConversationInteractionRepository {
  constructor(private readonly db: Database.Database) {}

  insert(value: ConversationInteractionDto): ConversationInteractionDto {
    this.db.prepare(`INSERT INTO conversation_interactions
      (id,task_id,execution_id,assistant_message_id,kind,title,description,options_json,min_selections,
       max_selections,allow_custom,custom_placeholder,status,answer_json,version,created_at,resolved_at)
      VALUES (@id,@taskId,@executionId,@assistantMessageId,@kind,@title,@description,@optionsJson,@minSelections,
       @maxSelections,@allowCustom,@customPlaceholder,@status,@answerJson,@version,@createdAt,@resolvedAt)`).run({
      ...value,
      description: value.description ?? null,
      optionsJson: JSON.stringify(value.options),
      minSelections: value.minSelections ?? null,
      maxSelections: value.maxSelections ?? null,
      allowCustom: value.allowCustom ? 1 : 0,
      customPlaceholder: value.customPlaceholder ?? null,
      answerJson: value.answer === undefined ? null : JSON.stringify(value.answer),
      resolvedAt: value.resolvedAt ?? null,
    });
    return this.get(value.id)!;
  }

  get(id: string): ConversationInteractionDto | undefined {
    const row = this.db.prepare("SELECT * FROM conversation_interactions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  listByTask(taskId: string): ConversationInteractionDto[] {
    return (this.db.prepare(
      "SELECT * FROM conversation_interactions WHERE task_id=? ORDER BY created_at ASC, rowid ASC",
    ).all(taskId) as Row[]).map(mapRow);
  }

  deleteFrom(taskId: string, createdAt: number): number {
    return this.db.prepare("DELETE FROM conversation_interactions WHERE task_id=? AND created_at>=?")
      .run(taskId, createdAt).changes;
  }

  settle(id: string, status: Exclude<ConversationInteractionStatus, "pending">, answer?: ConversationInteractionAnswer): ConversationInteractionDto | undefined {
    const result = this.db.prepare(`UPDATE conversation_interactions
      SET status=?, answer_json=?, version=version+1, resolved_at=? WHERE id=? AND status='pending'`)
      .run(status, answer === undefined ? null : JSON.stringify(answer), Date.now(), id);
    return result.changes > 0 ? this.get(id) : undefined;
  }

  pendingByExecution(executionId: string): ConversationInteractionDto | undefined {
    const row = this.db.prepare(
      "SELECT * FROM conversation_interactions WHERE execution_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
    ).get(executionId) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  expireAllPending(): ConversationInteractionDto[] {
    const rows = this.db.prepare("SELECT * FROM conversation_interactions WHERE status='pending'").all() as Row[];
    const settle = this.db.prepare(
      "UPDATE conversation_interactions SET status='expired', version=version+1, resolved_at=? WHERE id=? AND status='pending'",
    );
    const now = Date.now();
    this.db.transaction(() => rows.forEach((row) => settle.run(now, row.id)))();
    return rows.map((row) => this.get(row.id)!).filter(Boolean);
  }
}

function mapRow(row: Row): ConversationInteractionDto {
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
