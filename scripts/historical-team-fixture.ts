import type Database from "better-sqlite3";
import type { WorkService } from "../src/main/agent/work/WorkService";
import { DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

/** Persist historical records directly; retired team creation must stay unavailable. */
export function seedHistoricalTeam(db: Database.Database, works: WorkService, memberId: string, workspace: string, operationId: string) {
  const result = works.createWork({kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS}, {
    operationId, title: "Historical team", ownerBotId: DEFAULT_BOT_ID, workspacePath: workspace,
    inputSnapshotId: `${operationId}-input`,
  });
  if (!result.ok) throw new Error(result.message);
  const work = result.work;
  const plan = {ownerBotId: DEFAULT_BOT_ID, ownerResponsibility: "Summarize", executionPolicy: "sequential",
    members: [{botId: memberId, responsibility: "Inspect", delegatedScope: ["workspace:read"]}]};
  db.prepare("INSERT INTO work_teams(work_id,user_id,operation_id,request_hash,plan_json,intent_revision,input_snapshot_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(work.workId, LOCAL_USER_ID, operationId, "historical-fixture", JSON.stringify(plan), work.intentRevision, work.inputSnapshotId, 1);
  const taskId = `${operationId}-member`;
  const insert = db.prepare("INSERT INTO work_team_executions(work_id,ordinal,bot_id,task_id,role,responsibility,scopes_json) VALUES (?,?,?,?,?,?,?)");
  insert.run(work.workId, 0, memberId, taskId, "member", "Inspect", '["workspace:read"]');
  insert.run(work.workId, 1, DEFAULT_BOT_ID, `${operationId}-owner`, "owner_summary", "Summarize", '[]');
  return {workId: work.workId, taskId};
}
