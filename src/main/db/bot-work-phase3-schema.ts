import { ensureWorkGeneratedArtifactTables } from "../agent/work/WorkGeneratedArtifacts";
import type Database from "better-sqlite3";
import { ensureWorkArtifactTables } from "../agent/work/WorkArtifactValidation";
import { ensureWorkPausedTables } from "../agent/work/WorkPausedBacklog";
import { ensureWorkPartialTables } from "../agent/work/WorkPartialResults";
import { ensureWorkCollaborationTables } from "../agent/work/WorkCollaborationService";

/** Current schema only. Incompatible databases use AppDatabase's backup/reset contract. */
export function ensureBotWorkPhase3Tables(db: Database.Database): void {
  ensureWorkPartialTables(db);
  ensureWorkArtifactTables(db);
  ensureWorkGeneratedArtifactTables(db);
  ensureWorkPausedTables(db);
  ensureWorkCollaborationTables(db);
  // New business facts share the existing per-user stream and retention boundary.
  const sources: Array<[string, (row: string) => string]> = [
    ["work_subitem_results", row => `${row}.work_id`],
    ["work_continuation_plans", row => `${row}.work_id`],
    ["work_artifact_dependencies", row => `${row}.work_id`],
    ["work_generated_artifacts", row => `(SELECT work_id FROM work_execution_bindings WHERE binding_id=${row}.binding_id)`],
    ["work_collaboration_messages", row => `${row}.work_id`],
    ["work_handoff_preparations", row => `${row}.work_id`],
    ["work_delegation_adoptions", row => `(SELECT work_id FROM work_execution_bindings WHERE binding_id=${row}.binding_id)`],
    ["work_notification_identity", row => `(SELECT work_id FROM work_notifications WHERE notification_id=${row}.notification_id)`],
    ["work_notification_attempts", row => `(SELECT work_id FROM work_notifications WHERE notification_id=${row}.notification_id)`],
  ];
  for (const [table, reference] of sources) for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const workId = reference(operation === "DELETE" ? "OLD" : "NEW");
    const userId = `(SELECT user_id FROM works WHERE work_id=${workId})`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS phase3_projection_${table}_${operation} AFTER ${operation} ON ${table}
      WHEN ${userId} IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT ${userId}
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=${userId});
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=${userId};
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,${workId} FROM work_projection_streams WHERE user_id=${userId};
    END;`);
  }

}
