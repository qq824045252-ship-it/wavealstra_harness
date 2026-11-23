import type Database from "better-sqlite3";
import { DOTS_TASK_ID, type DotsActivityItem, type DotsDelegation } from "../../shared/dots";
import { readDotsWorkerOutcome } from "./DotsWorkerOutcome";

type ActivityRow = {
  operation_id: string; task_id: string; title: string; space: string | null;
  status: DotsDelegation["status"]; text: string; file_count: number; updated_at: number;
  interaction_id: string | null; question_message_id: string | null; question_title: string | null;
  question_description: string | null; last_activity_at: number | null;
  delivery_key: string | null; delivered: "question" | "conclusion" | null;
  summary: string | null; delivered_at: number | null; delivered_file_count: number | null;
  following: number; control: "paused" | "stopped" | null;
  goal_lifecycle: string | null; goal_conclusion: string | null;
};

export class DotsActivity {
  constructor(private readonly db: Database.Database, private readonly visible: (taskId: string) => boolean) {
    db.exec("CREATE INDEX IF NOT EXISTS dots_delegations_task_seq ON dots_delegations(task_id,seq DESC)");
  }

  list(): DotsActivityItem[] {
    if (!this.db.open) return [];
    const rows = this.db.prepare(`SELECT d.operation_id,d.task_id,t.title,s.name AS space,d.status,d.text,d.updated_at,
      json_array_length(d.files) AS file_count,d.interaction_id,i.assistant_message_id AS question_message_id,
      i.title AS question_title,i.description AS question_description,a.at AS last_activity_at,
      COALESCE(json_extract(e.snapshot,'$.deliveryKey'),e.event_key) AS delivery_key,
      json_extract(e.snapshot,'$.delivered') AS delivered,json_extract(e.snapshot,'$.summary') AS summary,
      json_extract(e.snapshot,'$.deliveredAt') AS delivered_at,json_extract(e.snapshot,'$.fileCount') AS delivered_file_count,
      EXISTS(SELECT 1 FROM dots_reply_events p WHERE p.operation_id=d.operation_id AND p.status=d.status AND p.settled=0) AS following,
      c.state AS control,w.lifecycle AS goal_lifecycle,w.closure_conclusion AS goal_conclusion
      FROM tasks t JOIN dots_delegations d ON d.seq=COALESCE(
        (SELECT waiting.seq FROM dots_delegations waiting JOIN conversation_interactions pending
          ON pending.id=waiting.interaction_id AND pending.task_id=t.id AND pending.status='pending'
          WHERE waiting.task_id=t.id AND waiting.status='blocked' ORDER BY waiting.seq DESC LIMIT 1),
        (SELECT latest.seq FROM dots_delegations latest WHERE latest.task_id=t.id ORDER BY latest.seq DESC LIMIT 1))
      LEFT JOIN spaces s ON s.id=t.space_id
      LEFT JOIN dots_target_controls c ON c.task_id=d.task_id LEFT JOIN works w ON w.work_id=d.goal_id
      LEFT JOIN conversation_interactions i ON i.id=d.interaction_id AND i.task_id=d.task_id AND i.status='pending'
      LEFT JOIN dots_tool_observations a ON a.operation_id=d.operation_id
      LEFT JOIN dots_reply_events e ON e.rowid=(SELECT r.rowid FROM dots_reply_events r
        WHERE r.operation_id=d.operation_id AND r.status=d.status AND r.interaction_id IS d.interaction_id
          AND r.settled=1 AND json_valid(r.snapshot)
          AND json_extract(r.snapshot,'$.delivered') IN ('question','conclusion') ORDER BY r.rowid DESC LIMIT 1)
      WHERE t.archived=0
      ORDER BY COALESCE(delivered_at, d.updated_at) DESC,d.seq DESC`).all() as ActivityRow[];

    return rows.flatMap<DotsActivityItem>(row => {
      if (!this.visible(row.task_id)) return [];
      const summary = row.summary ?? activitySummary(readDotsWorkerOutcome(row.text)?.result ?? row.text);
      const task = { id: row.operation_id, taskId: row.task_id, title: row.title, space: row.space ?? "独立任务",
        summary, updatedAt: row.delivered_at ?? row.updated_at };
      if (row.delivered === "conclusion" && row.delivery_key) {
        return [{ ...task, state: "delivered", deliveryKey: row.delivery_key, fileCount: row.delivered_file_count ?? row.file_count }];
      }
      if (row.control === "stopped" || row.goal_conclusion === "cancelled") return [{ ...task, state: "stopped" }];
      if (row.control === "paused" || row.goal_lifecycle === "paused") return [{ ...task, state: "paused" }];
      if (row.goal_conclusion === "ended_unsuccessfully") return [{ ...task, state: "failed" }];
      if (row.interaction_id && row.question_message_id) {
        const question = [row.question_title, row.question_description].filter(Boolean).join("\n");
        return [{ ...task, state: "waiting", summary: activitySummary(question),
          target: { taskId: row.task_id, messageId: row.question_message_id, interactionId: row.interaction_id } }];
      }
      if (!row.interaction_id && row.delivered === "question" && row.delivery_key) {
        return [{ ...task, state: "waiting", target: { taskId: DOTS_TASK_ID, messageId: row.delivery_key } }];
      }
      if (row.status === "failed" || row.status === "superseded") return [{ ...task, state: row.status }];
      if (row.status === "blocked" && !row.interaction_id) return [{ ...task, state: "blocked" }];
      if (row.status === "completed" && !row.following) return [{ ...task, state: "undelivered" }];
      return [{ ...task, state: "running", phase: row.status === "pending" ? "queued" : row.status === "running" ? "working" : "following",
        lastActivityAt: row.last_activity_at ?? undefined }];
    });
  }

}

export function activitySummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 560 ? trimmed.slice(0, 559).trimEnd() + "…" : trimmed;
}
