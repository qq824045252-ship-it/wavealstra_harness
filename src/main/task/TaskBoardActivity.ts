import type Database from "better-sqlite3";
import { LOCAL_USER_ID } from "../../shared/bot-work";
import { botWorkspaceSpaceId, teamWorkspaceSpaceId } from "../agent/work/BotWorkspaceNavigationService";

// One observation per local day and kind. History can match an older day even after a newer visit.
const localDay = (time: string) => `date((${time})/1000.0,'unixepoch','localtime')`;
function observation(id: string, kind: string, at: string, from: string, detail = "''"): string {
  return `INSERT INTO task_board_days(id,kind,day,at,detail)
    SELECT ${id},'${kind}',${localDay(at)},${at},substr(${detail},1,120) ${from}
    ON CONFLICT(id,kind,day) DO UPDATE SET at=excluded.at,detail=excluded.detail WHERE excluded.at>=task_board_days.at`;
}

export function ensureTaskBoard(db: Database.Database): void {
  db.function("board_space", { deterministic: true }, (bot: string, team: string | null) =>
    team ? teamWorkspaceSpaceId(team) : botWorkspaceSpaceId(bot),
  );
  const botId = "'bot-request:'||r.bot_id||':'||r.request_id";
  const botSource = `FROM bot_send_receipts r JOIN bot_conversations c ON c.conversation_id=r.conversation_id
    JOIN bot_messages u ON u.message_id=r.user_message_id JOIN bot_messages a ON a.message_id=r.assistant_message_id
    WHERE r.user_id='${LOCAL_USER_ID}' AND c.user_id=r.user_id AND c.conversation_id NOT GLOB 'bot-inbox-*'`;
  const humanSource =
    botSource +
    " AND c.source_kind='user' AND c.ingress_kind='desktop' AND NOT EXISTS (SELECT 1 FROM bot_peer_inputs p WHERE p.assistant_message_id=a.message_id)";
  const terminal = "('completed','failed')";
  db.transaction(() => {
    const installed = db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_board_days'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS task_board_days(
        id TEXT NOT NULL,kind TEXT NOT NULL,day TEXT NOT NULL,at INTEGER NOT NULL,detail TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(id,kind,day)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_board_days_time ON task_board_days(kind,at DESC,id);
      CREATE TABLE IF NOT EXISTS task_board_plans(id TEXT PRIMARY KEY, day TEXT, later_until INTEGER, deferred_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_board_task_date ON tasks(due_at,id) WHERE archived=0 AND due_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_board_task_update ON tasks(updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS idx_board_task_status ON tasks(status,updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS idx_board_task_pin ON tasks(is_favorited,updated_at DESC,id) WHERE is_favorited=1;
      CREATE INDEX IF NOT EXISTS idx_board_request_key ON bot_send_receipts(('bot-request:'||bot_id||':'||request_id));
      CREATE INDEX IF NOT EXISTS idx_board_receipt_assistant ON bot_send_receipts(assistant_message_id);
      CREATE INDEX IF NOT EXISTS idx_board_pending_question ON conversation_interactions(status,task_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_board_terminal_notice ON notifications(task_id,created_at DESC) WHERE type IN ('task.failed','task.completed');
      CREATE INDEX IF NOT EXISTS idx_board_cron_task ON cron_runs(task_id,started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_board_cron_job ON cron_runs(job_id,started_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_board_cron_started ON cron_runs(started_at DESC,id);
      CREATE TEMP TABLE IF NOT EXISTS board_waits(id TEXT NOT NULL, token TEXT NOT NULL, message TEXT, detail TEXT, at INTEGER, PRIMARY KEY(id,token));
      CREATE TEMP VIEW IF NOT EXISTS board_native AS SELECT t.id,t.title,t.space_id,t.status,t.updated_at,t.start_at,t.due_at,
        t.is_favorited AS pinned,t.done_acked_at AS ack,NULL AS request_data,NULL AS source_error FROM tasks t WHERE t.archived=0
        AND (t.space_id IS NOT NULL OR NOT (t.id GLOB 'gateway-chat-*' AND length(t.id)=77 AND substr(t.id,14) NOT GLOB '*[^a-f0-9]*'))
        AND NOT EXISTS (SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed');
      CREATE TEMP VIEW IF NOT EXISTS board_requests AS SELECT ${botId} AS id,coalesce(nullif(trim(substr(u.text,1,120)),''),'附件对话') AS title,
        board_space(r.bot_id,c.team_id) AS space_id,
        CASE a.status WHEN 'queued' THEN 'pending' WHEN 'running' THEN 'in_progress' WHEN 'cancelled' THEN 'stopped' ELSE a.status END AS status,
        a.updated_at,NULL AS start_at,NULL AS due_at,0 AS pinned,NULL AS ack,
        json_object('botId',r.bot_id,'teamId',c.team_id,'conversationId',r.conversation_id,'requestId',r.request_id,
          'messageId',a.message_id,'createdAt',u.created_at,'status',a.status) AS request_data,a.error AS source_error
        ${botSource} AND c.archived_at IS NULL;
      CREATE TRIGGER IF NOT EXISTS board_task_end_insert AFTER INSERT ON tasks WHEN NEW.status IN ${terminal} BEGIN
        ${observation("NEW.id", "result", "NEW.updated_at", "WHERE 1")}; END;
      CREATE TRIGGER IF NOT EXISTS board_task_end_update AFTER UPDATE OF status ON tasks WHEN NEW.status IN ${terminal} AND OLD.status IS NOT NEW.status BEGIN
        ${observation("NEW.id", "result", "max(NEW.updated_at,CAST(unixepoch('subsec')*1000 AS INTEGER))", "WHERE 1")}; END;
      CREATE TRIGGER IF NOT EXISTS board_artifact_created AFTER INSERT ON artifacts BEGIN
        ${observation("NEW.task_id", "result", "NEW.updated_at", "WHERE 1", "coalesce(NEW.title,'')")}; END;
      CREATE TRIGGER IF NOT EXISTS board_artifact_version AFTER UPDATE OF version ON artifacts WHEN NEW.version>OLD.version BEGIN
        ${observation("NEW.task_id", "result", "NEW.updated_at", "WHERE 1", "coalesce(NEW.title,'')")}; END;
      CREATE TRIGGER IF NOT EXISTS board_question_answer AFTER UPDATE OF status ON conversation_interactions
        WHEN NEW.status='resolved' AND OLD.status='pending' AND NEW.resolved_at IS NOT NULL BEGIN
        ${observation("NEW.task_id", "follow", "NEW.resolved_at", "WHERE 1", "NEW.title")}; END;
      CREATE TRIGGER IF NOT EXISTS board_request_follow AFTER INSERT ON bot_send_receipts BEGIN
        ${observation(botId, "follow", "u.created_at", humanSource + " AND r.rowid=NEW.rowid", "u.text")}; END;
      CREATE TRIGGER IF NOT EXISTS board_peer_origin AFTER INSERT ON bot_peer_inputs BEGIN
        DELETE FROM task_board_days WHERE kind='follow' AND id IN (SELECT ${botId} FROM bot_send_receipts r WHERE r.assistant_message_id=NEW.assistant_message_id); END;
      CREATE TRIGGER IF NOT EXISTS board_request_result AFTER UPDATE OF status ON bot_messages
        WHEN NEW.role='assistant' AND NEW.status IN ${terminal} AND OLD.status IS NOT NEW.status BEGIN
        ${observation(botId, "result", "NEW.updated_at", botSource + " AND a.message_id=NEW.message_id")}; END;
      CREATE TRIGGER IF NOT EXISTS board_task_delete AFTER DELETE ON tasks BEGIN
        DELETE FROM task_board_days WHERE id=OLD.id; DELETE FROM task_board_plans WHERE id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS board_request_delete AFTER DELETE ON bot_send_receipts BEGIN
        DELETE FROM task_board_days WHERE id='bot-request:'||OLD.bot_id||':'||OLD.request_id;
        DELETE FROM task_board_plans WHERE id='bot-request:'||OLD.bot_id||':'||OLD.request_id; END;`);
    if (!installed) {
      db.exec(
        observation(
          "task_id",
          "result",
          "captured_at",
          "FROM memory_turns WHERE assistant_message_id IS NOT NULL",
        ),
      );
      db.exec(observation("task_id", "result", "updated_at", "FROM artifacts WHERE 1", "coalesce(title,'')"));
      db.exec(
        observation(
          "task_id",
          "follow",
          "resolved_at",
          "FROM conversation_interactions WHERE status='resolved' AND resolved_at IS NOT NULL",
          "title",
        ),
      );
      db.exec(observation(botId, "follow", "u.created_at", humanSource, "u.text"));
      db.exec(observation(botId, "result", "a.updated_at", botSource + " AND a.status IN " + terminal));
      db.exec(
        observation(
          "task_id",
          "result",
          "created_at",
          "FROM notifications WHERE type IN ('task.completed','task.failed') AND task_id IS NOT NULL",
        ),
      );
    }
  })();
}
