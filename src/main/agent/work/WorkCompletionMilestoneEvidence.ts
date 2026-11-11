import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";

/** Persisted host delivery receipts, not executor claims or user read receipts.
 * Never resolve old files against today's mutable artifact registry. */
export function completionMilestoneEvidence(db: Database.Database, binding: WorkExecutionBindingDto) {
  const eventId = `milestone:${binding.bindingId}`;
  const prefix = `work-feedback:${createHash("sha256").update(JSON.stringify([binding.workId, eventId])).digest("hex")}:`;
  // The existing UNIQUE(conversation_id,request_id,role) index bounds the
  // request range before any feedback JSON is inspected. CROSS JOIN preserves
  // that route -> message -> feedback lookup order even on long chat histories.
  const rows = db.prepare(`SELECT m.message_id,m.ordinal,m.created_at,b.settled_at,
      substr(json_extract(f.metadata_json,'$.report.summary'),1,2000) summary,
      (SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(f.metadata_json,'$.report.files')
        WHERE length(value)<=6000 LIMIT 20)) files_json,
      json_array_length(f.metadata_json,'$.report.files') file_count,
      length(json_extract(f.metadata_json,'$.report.summary')) summary_length,COUNT(*) OVER () total
    FROM work_execution_bindings b JOIN works w ON w.work_id=b.work_id
    JOIN work_conversations t ON t.work_id=w.work_id AND t.channel_type='bot-delivery'
    JOIN bot_conversations c ON c.conversation_id=t.conversation_id AND c.user_id=w.user_id
    CROSS JOIN bot_messages m
    CROSS JOIN bot_work_feedback f
    WHERE b.binding_id=? AND m.conversation_id=t.conversation_id AND m.bot_id=c.bot_id
      AND f.message_id=m.message_id AND b.work_id=? AND b.intent_revision=? AND b.input_snapshot_id=? AND b.owner_epoch=?
      AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id AND b.owner_epoch=w.owner_epoch
      AND b.invalidated_at IS NULL AND b.status!='invalidated'
      AND json_extract(f.metadata_json,'$.workId')=b.work_id
      AND json_extract(f.metadata_json,'$.executionId')=b.binding_id
      AND json_extract(f.metadata_json,'$.intentRevision')=b.intent_revision
      AND json_extract(f.metadata_json,'$.inputSnapshotId')=b.input_snapshot_id
      AND json_extract(f.metadata_json,'$.eventId')=?
      AND json_extract(f.metadata_json,'$.report.milestone')=1
      AND m.role='assistant' AND m.status='completed' AND m.message_id LIKE 'work-feedback-%'
      AND m.request_id>=? AND m.request_id<? AND m.created_at>=b.admitted_at
    ORDER BY m.ordinal ASC LIMIT 20`).all(binding.bindingId,binding.workId,binding.intentRevision,binding.inputSnapshotId,
      binding.ownerEpoch,eventId,prefix,`${prefix.slice(0,-1)};`) as Array<{message_id:string;ordinal:number;created_at:number;settled_at:number|null;summary:string;files_json:string|null;file_count:number;summary_length:number;total:number}>;
  let remaining = 48000;
  return {
    meaning: "host_persisted_original_conversation_delivery_not_user_read_or_overall_completion",
    omittedDeliveryCount: Math.max(0,(rows[0]?.total ?? 0)-rows.length),
    deliveries: rows.map(row => {
      const files: Array<{ref:string;name:string;openPath?:string}> = row.files_json ? JSON.parse(row.files_json) : [];
      const shown = files.filter(file => {
        const size = JSON.stringify(file).length;
        if (size > remaining) return false;
        remaining -= size; return true;
      });
      return {messageId:row.message_id,ordinal:row.ordinal,createdAt:row.created_at,settledAt:row.settled_at,
        millisecondsBeforeSettlement:row.settled_at === null ? null : row.settled_at-row.created_at,
        summary:row.summary,summaryTrust:"untrusted_report_content",summaryTruncated:row.summary_length>2000,
        files:shown,omittedFileCount:Math.max(0,(row.file_count ?? 0)-shown.length)};
    }),
  };
}
