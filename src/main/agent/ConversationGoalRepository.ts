import type Database from "better-sqlite3";
import type { ConversationGoalDto, ConversationGoalStatus, GoalCriterionDto } from "../../shared/conversation-goal";

type Row = {
  id: string; task_id: string; title: string; description: string | null; status: ConversationGoalStatus;
  criteria_json: string; progress_summary: string | null; version: number;
  created_by: ConversationGoalDto["createdBy"]; created_at: number; updated_at: number; achieved_at: number | null;
};

export class ConversationGoalRepository {
  constructor(private readonly db: Database.Database) {}

  insert(goal: ConversationGoalDto): ConversationGoalDto {
    this.db.prepare(`INSERT INTO conversation_goals
      (id,task_id,title,description,status,criteria_json,progress_summary,version,created_by,created_at,updated_at,achieved_at)
      VALUES (@id,@taskId,@title,@description,@status,@criteriaJson,@progressSummary,@version,@createdBy,@createdAt,@updatedAt,@achievedAt)`)
      .run({
        ...goal,
        description: goal.description ?? null,
        criteriaJson: JSON.stringify(goal.criteria),
        progressSummary: goal.progressSummary ?? null,
        achievedAt: goal.achievedAt ?? null,
      });
    return this.get(goal.id)!;
  }

  get(id: string): ConversationGoalDto | undefined {
    const row = this.db.prepare("SELECT * FROM conversation_goals WHERE id=?").get(id) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  getLiveByTask(taskId: string): ConversationGoalDto | undefined {
    const row = this.db.prepare(`SELECT * FROM conversation_goals WHERE task_id=?
      AND status IN ('active','blocked','paused')
      ORDER BY CASE WHEN status IN ('active','blocked') THEN 0 ELSE 1 END, updated_at DESC, rowid DESC LIMIT 1`).get(taskId) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  listByTask(taskId: string): ConversationGoalDto[] {
    return (this.db.prepare("SELECT * FROM conversation_goals WHERE task_id=? ORDER BY created_at ASC, rowid ASC")
      .all(taskId) as Row[]).map(mapRow);
  }

  update(goal: ConversationGoalDto): ConversationGoalDto {
    this.db.prepare(`UPDATE conversation_goals SET title=@title,description=@description,status=@status,
      criteria_json=@criteriaJson,progress_summary=@progressSummary,version=@version,updated_at=@updatedAt,
      achieved_at=@achievedAt WHERE id=@id`).run({
      ...goal,
      description: goal.description ?? null,
      criteriaJson: JSON.stringify(goal.criteria),
      progressSummary: goal.progressSummary ?? null,
      achievedAt: goal.achievedAt ?? null,
    });
    return this.get(goal.id)!;
  }
}

function mapRow(row: Row): ConversationGoalDto {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    criteria: JSON.parse(row.criteria_json) as GoalCriterionDto[],
    progressSummary: row.progress_summary ?? undefined,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    achievedAt: row.achieved_at ?? undefined,
  };
}
