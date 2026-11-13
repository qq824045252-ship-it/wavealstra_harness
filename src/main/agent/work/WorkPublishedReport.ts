import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkDto, WorkProjectionDto } from "../../../shared/bot-work";
import { workFeedbackSchema } from "../../../shared/bot-work-feedback";

const rowSchema = z.object({ message_id: z.string(), created_at: z.number(), metadata_json: z.string() });

/** Read the already-published review. Opening details must never review or deliver again. */
export function readWorkPublishedReport(db: Database.Database, work: WorkDto): WorkProjectionDto["publishedReport"] {
  const parameters = { work: work.workId, user: work.userId, intent: work.intentRevision,
    input: work.inputSnapshotId, epoch: work.ownerEpoch };
  const current = (metadata: string) => `
    json_extract(${metadata},'$.workId')=@work
    AND json_extract(${metadata},'$.intentRevision')=@intent
    AND json_extract(${metadata},'$.inputSnapshotId')=@input
    AND json_extract(${metadata},'$.report.completion') IS NOT NULL
    AND json_extract(${metadata},'$.report.current')=1
    AND COALESCE(json_extract(${metadata},'$.report.milestone'),0)=0
    AND EXISTS (SELECT 1 FROM work_execution_bindings b
      WHERE b.binding_id=json_extract(${metadata},'$.executionId') AND b.work_id=@work
      AND b.intent_revision=@intent AND b.input_snapshot_id=@input AND b.owner_epoch=@epoch
      AND b.invalidated_at IS NULL AND b.status!='invalidated')`;
  const conversation = db.prepare(`SELECT m.message_id,m.created_at,f.metadata_json
    FROM work_conversations w JOIN bot_conversations c ON c.conversation_id=w.conversation_id AND c.user_id=@user
    JOIN bot_messages m ON m.conversation_id=c.conversation_id
    JOIN bot_work_feedback f ON f.message_id=m.message_id
    WHERE w.work_id=@work AND m.role='assistant' AND m.status='completed' AND ${current("f.metadata_json")}
    ORDER BY m.ordinal DESC LIMIT 1`).get(parameters);
  const candidates = conversation ? [rowSchema.parse(conversation)] : [];
  // Collaboration can retain the same publication after its source conversation is deleted.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_collaboration_messages'").get()) {
    const metadata = "json_extract(m.value_json,'$.workFeedback')";
    const collaboration = db.prepare(`SELECT m.message_id,json_extract(m.value_json,'$.createdAt') created_at,
      ${metadata} metadata_json FROM bot_collaborations c
      JOIN bot_collaboration_messages m ON m.collaboration_id=c.collaboration_id
      WHERE c.work_id=@work AND c.user_id=@user AND ${current(metadata)} ORDER BY m.ordinal DESC LIMIT 1`).get(parameters);
    if (collaboration) candidates.push(rowSchema.parse(collaboration));
  }
  for (const row of candidates.sort((a, b) => b.created_at - a.created_at)) {
    const parsed = workFeedbackSchema.safeParse(JSON.parse(row.metadata_json));
    if (!parsed.success) continue;
    const { report, executionId, intentRevision, inputSnapshotId } = parsed.data;
    if (!report?.completion || !executionId || intentRevision === undefined || !inputSnapshotId) continue;
    return { messageId: row.message_id, createdAt: row.created_at, executionId, intentRevision, inputSnapshotId, report };
  }
  return undefined;
}
