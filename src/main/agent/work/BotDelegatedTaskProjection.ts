import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkFeedbackDto } from "../../../shared/bot-work-feedback";
import { enqueueWorkOp, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites, workDomainRunTx } from "./WorkDomainRuntime";

/** Only the host's public report is forwarded; the execution log is never a
 * fallback. This function deliberately has no raw-text argument. */
export function delegatedFeedbackText(feedback: WorkFeedbackDto): string {
  if (feedback.report) return `【${feedback.report.title}】\n${feedback.report.summary}`;
  const labels: Record<WorkFeedbackDto["kind"], string> = {
    binding: "受托方的执行状态已更新。", result: "受托方已返回执行记录，最终结论以任务核对结果为准。",
    blocker: "委托任务有待处理事项，请查看任务状态。", closure: "委托任务已结束，完成结论以任务状态为准。",
  };
  return labels[feedback.kind];
}

/** Read-only presentation association. In particular, never link a peer return
 * to the user's control-target or delivery-origin columns. Source replies and
 * both ends of authenticated peer turns use the same immutable Work identity. */
export function delegatedReplyWorkIds(db: Pick<Database.Database, "prepare">, userId: string, messageId: string): string[] {
  const rows = db.prepare(`
    SELECT c.work_id FROM bot_messages m
      JOIN bot_send_receipts r ON r.assistant_message_id=m.message_id AND r.bot_id=m.bot_id
        AND r.request_id=m.request_id AND r.conversation_id=m.conversation_id
      JOIN bot_conversations v ON v.conversation_id=m.conversation_id AND v.user_id=r.user_id AND v.bot_id=m.bot_id
      JOIN bot_collaboration_requests q ON q.assistant_message_id=r.assistant_message_id
        AND q.user_message_id=r.user_message_id AND q.request_id=r.request_id AND q.conversation_id=r.conversation_id
      JOIN bot_collaborations c ON c.collaboration_id=q.collaboration_id AND c.user_id=r.user_id AND c.source_bot_id=m.bot_id
        AND c.source_conversation_id=r.conversation_id
        AND json_extract(c.value_json,'$.sourceRequestId')=r.request_id
        AND json_extract(c.value_json,'$.sourceUserMessageId')=r.user_message_id
        AND json_extract(c.value_json,'$.sourceAssistantMessageId')=r.assistant_message_id
      JOIN works w ON w.work_id=c.work_id AND w.user_id=c.user_id
    WHERE m.message_id=? AND m.role='assistant' AND r.user_id=? AND v.team_id IS NULL
    UNION
    SELECT c.work_id FROM bot_messages m
      JOIN bot_send_receipts r ON r.assistant_message_id=m.message_id AND r.bot_id=m.bot_id
        AND r.request_id=m.request_id AND r.conversation_id=m.conversation_id
      JOIN bot_conversations v ON v.conversation_id=m.conversation_id AND v.user_id=r.user_id AND v.bot_id=m.bot_id
      JOIN bot_peer_inputs p ON p.assistant_message_id=r.assistant_message_id AND p.user_message_id=r.user_message_id
      JOIN bot_peer_deliveries d ON d.accepted_message_id=m.message_id AND d.user_id=r.user_id
        AND d.target_bot_id=r.bot_id AND d.request_id=r.request_id
        AND d.operation_id=json_extract(p.origin_json,'$.exchangeId') AND d.origin_json=p.origin_json
      JOIN bot_collaborations c ON c.collaboration_id=json_extract(p.origin_json,'$.collaborationId') AND c.user_id=r.user_id
      JOIN works w ON w.work_id=c.work_id AND w.user_id=c.user_id
      JOIN bot_collaboration_requests q ON q.collaboration_id=c.collaboration_id
        AND q.assistant_message_id=json_extract(p.origin_json,'$.sourceAssistantMessageId')
        AND q.user_message_id=json_extract(p.origin_json,'$.sourceUserMessageId')
        AND q.request_id=json_extract(p.origin_json,'$.sourceRequestId')
        AND q.conversation_id=json_extract(p.origin_json,'$.sourceConversationId')
      JOIN bot_send_receipts s ON s.user_id=c.user_id AND s.bot_id=c.source_bot_id
        AND s.conversation_id=q.conversation_id AND s.request_id=q.request_id
        AND s.user_message_id=q.user_message_id AND s.assistant_message_id=q.assistant_message_id
    WHERE m.message_id=? AND m.role='assistant' AND r.user_id=? AND v.team_id IS NULL
      AND json_extract(p.origin_json,'$.sourceBotId')=c.source_bot_id
      AND ((json_extract(p.origin_json,'$.kind')='return' AND m.bot_id=c.source_bot_id
        AND m.conversation_id=q.conversation_id AND json_extract(p.origin_json,'$.senderBotId')=c.target_bot_id)
        OR (json_extract(p.origin_json,'$.kind')='request' AND m.bot_id=c.target_bot_id
        AND json_extract(p.origin_json,'$.senderBotId')=c.source_bot_id))
    ORDER BY 1`).all(messageId, userId, messageId, userId) as Array<{ work_id: string }>;
  return rows.map(row => row.work_id);
}

/** Repair current-format source projections in bounded batches. The identity is
 * (source conversation, exact execution feedback message), not the latest Work
 * state. Live delivery and reload use this same path, so retries cannot create
 * duplicate history, enqueue a model turn, or rerun the delegated Work.
 *
 * parseFeedback is the production workFeedbackSchema.parse boundary. Keeping
 * it injectable also lets the SQL/projection contract be tested independently.
 */
export function reconcileDelegatedFeedback(db: Database.Database, userId: string, conversationId: string,
  parseFeedback: (value: unknown) => WorkFeedbackDto, workId?: string): number {
  const rust = requiresWorkRustWrites(db);
  return workDomainRunTx(db, () => {
    const convRow = overlayReadOne<{ bot_id: string; user_id: string; team_id: string | null }>(db, "bot_conversations", conversationId, () =>
      db.prepare("SELECT bot_id,user_id,team_id FROM bot_conversations WHERE user_id=? AND conversation_id=? AND team_id IS NULL")
        .get(userId, conversationId) as { bot_id: string; user_id: string; team_id: string | null } | undefined);
    const source = convRow && convRow.user_id === userId && convRow.team_id === null ? { bot_id: convRow.bot_id } : undefined;
    if (!source) return 0;
    const rows = db.prepare(`SELECT DISTINCT m.message_id,m.created_at,m.updated_at,m.ordinal,f.metadata_json
      FROM bot_collaborations c
      JOIN bot_send_receipts s ON s.user_id=c.user_id AND s.bot_id=c.source_bot_id
        AND s.conversation_id=c.source_conversation_id
        AND s.request_id=json_extract(c.value_json,'$.sourceRequestId')
        AND s.user_message_id=json_extract(c.value_json,'$.sourceUserMessageId')
        AND s.assistant_message_id=json_extract(c.value_json,'$.sourceAssistantMessageId')
      JOIN works w ON w.work_id=c.work_id AND w.user_id=c.user_id
      JOIN bot_peer_deliveries d ON d.user_id=c.user_id AND d.target_bot_id=c.target_bot_id
        AND json_extract(d.origin_json,'$.collaborationId')=c.collaboration_id
        AND json_extract(d.origin_json,'$.kind')='request'
      JOIN bot_messages accepted ON accepted.message_id=d.accepted_message_id AND accepted.bot_id=c.target_bot_id
      JOIN bot_send_receipts r ON r.assistant_message_id=accepted.message_id AND r.user_id=c.user_id
        AND r.bot_id=c.target_bot_id AND r.request_id=d.request_id AND r.conversation_id=accepted.conversation_id
      JOIN bot_conversations receiver ON receiver.conversation_id=r.conversation_id AND receiver.user_id=c.user_id AND receiver.team_id IS NULL
      JOIN bot_messages m ON m.conversation_id=receiver.conversation_id AND m.bot_id=c.target_bot_id AND m.role='assistant'
      JOIN bot_work_feedback f ON f.message_id=m.message_id AND json_extract(f.metadata_json,'$.workId')=c.work_id
      WHERE c.user_id=? AND c.source_conversation_id=? AND c.source_bot_id=?
        AND (? IS NULL OR c.work_id=?)
        AND NOT EXISTS (SELECT 1 FROM bot_messages mirror JOIN bot_work_feedback saved ON saved.message_id=mirror.message_id
          WHERE mirror.conversation_id=c.source_conversation_id AND mirror.request_id='delegated-feedback:'||m.message_id
            AND saved.metadata_json=f.metadata_json)
      ORDER BY m.ordinal ASC LIMIT 100`).all(userId, conversationId, source.bot_id, workId ?? null, workId ?? null) as Array<{
        message_id: string; created_at: number; updated_at: number; ordinal: number; metadata_json: string;
      }>;
    let changed = 0;
    // Oldest missing first: batches must not append older versions after newer ones.
    for (const row of rows) {
      const feedback = parseFeedback(JSON.parse(row.metadata_json));
      const messageId = `work-feedback-${createHash("sha256").update(JSON.stringify([conversationId, row.message_id])).digest("hex")}`;
      const text = delegatedFeedbackText(feedback);
      const metadata = JSON.stringify(feedback);
      const reqId = `delegated-feedback:${row.message_id}`;
      const workIdsJson = JSON.stringify([feedback.workId]);
      if (rust) {
        let didInsert = false;
        let didUpdate = false;
        let didAnnotate = false;
        overlayMutate(db, "bot_messages", messageId, () =>
          db.prepare("SELECT * FROM bot_messages WHERE message_id=?").get(messageId) as Record<string, unknown> | undefined,
        cur => {
          if (!cur) {
            didInsert = true;
            return {
              message_id: messageId, conversation_id: conversationId, bot_id: source.bot_id,
              request_id: reqId, role: "assistant", text, status: "completed",
              work_ids_json: workIdsJson, error: null, created_at: row.created_at, updated_at: row.updated_at,
            };
          }
          if (cur.text !== text) {
            didUpdate = true;
            return { ...cur, text, updated_at: row.updated_at };
          }
          return cur;
        });
        overlayMutate(db, "bot_work_feedback", messageId, () =>
          db.prepare("SELECT * FROM bot_work_feedback WHERE message_id=?").get(messageId) as Record<string, unknown> | undefined,
        cur => {
          if (!cur || cur.metadata_json !== metadata) {
            didAnnotate = true;
            return { message_id: messageId, metadata_json: metadata };
          }
          return cur;
        });
        enqueueWorkOp(db, {
          op: "botMsgInsert", messageId, conversationId, botId: source.bot_id, requestId: reqId,
          role: "assistant", text, status: "completed", workIdsJson, createdAt: row.created_at,
          updatedAt: row.updated_at, orIgnore: true, attachmentsJson: null,
        });
        enqueueWorkOp(db, { op: "botMsgTextUpdate", messageId, text, updatedAt: row.updated_at });
        enqueueWorkOp(db, { op: "botWorkFeedbackUpsert", messageId, metadataJson: metadata, overwrite: true });
        if (didInsert || didUpdate || didAnnotate) changed++;
      } else {
        const inserted = db.prepare(`INSERT OR IGNORE INTO bot_messages
          (message_id,conversation_id,bot_id,request_id,role,text,status,work_ids_json,created_at,updated_at)
          VALUES (?,?,?,?,'assistant',?,'completed',?,?,?)`)
          .run(messageId, conversationId, source.bot_id, reqId, text,
            workIdsJson, row.created_at, row.updated_at).changes;
        const updated = db.prepare("UPDATE bot_messages SET text=?,updated_at=? WHERE message_id=? AND text<>?")
          .run(text, row.updated_at, messageId, text).changes;
        const annotated = db.prepare(`INSERT INTO bot_work_feedback(message_id,metadata_json) VALUES (?,?)
          ON CONFLICT(message_id) DO UPDATE SET metadata_json=excluded.metadata_json
          WHERE bot_work_feedback.metadata_json<>excluded.metadata_json`).run(messageId, metadata).changes;
        if (inserted || updated || annotated) changed++;
      }
    }
    if (changed) {
      const now = Date.now();
      if (rust) {
        overlayMutate(db, "bot_conversations", conversationId, () =>
          db.prepare("SELECT * FROM bot_conversations WHERE conversation_id=?").get(conversationId) as Record<string, unknown> | undefined,
        cur => cur && cur.user_id === userId ? { ...cur, revision: Number(cur.revision ?? 0) + 1, updated_at: now } : cur);
        enqueueWorkOp(db, { op: "botConvBumpRevision", conversationId, userId, now });
      } else {
        db.prepare("UPDATE bot_conversations SET revision=revision+1,updated_at=? WHERE conversation_id=? AND user_id=?")
          .run(now, conversationId, userId);
      }
    }
    return changed;
  });
}
