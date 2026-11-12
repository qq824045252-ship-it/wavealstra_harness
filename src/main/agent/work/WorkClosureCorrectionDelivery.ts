import type Database from "better-sqlite3";
import { z } from "zod";

/** A reviewed conclusion is a new text fact, not authorization to replay file transport. */
export function closureCorrectionNotice(db: Database.Database, notification: { workId: string; cardKey?: string; channel?: string; targetKey?: string }): string | undefined {
  if (!notification.cardKey || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_closure_review_corrections'").get()) return;
  const correction = z.object({ operation_id: z.string() }).optional().parse(db.prepare(`
    SELECT r.operation_id FROM work_closure_review_corrections r
    JOIN work_execution_bindings b ON b.binding_id=r.binding_id AND b.work_id=r.work_id
    JOIN work_result_cards c ON c.work_id=r.work_id AND c.intent_revision=b.intent_revision
      AND c.input_snapshot_id=b.input_snapshot_id AND c.origin_owner_epoch=b.owner_epoch
    WHERE c.card_key=? AND c.work_id=? AND c.kind='closure_succeeded'
      AND json_extract(r.decision_json,'$.decision')='deliver'
      AND json_extract(r.decision_json,'$.outcome')='completed'
      AND json_extract(r.decision_json,'$.correction.kind')='host_delivery_responsibility'
      AND EXISTS (SELECT 1 FROM json_each(c.canonical_outcome_json,'$.sourceRefs') s
        WHERE s.value='closure-review-correction:' || r.operation_id)
    ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(notification.cardKey, notification.workId));
  if (!correction) return;
  const prior = z.object({ status: z.string(), receipt: z.string().nullable() }).array().parse(db.prepare(`
    SELECT a.status,a.receipt FROM work_notification_attempts a
    JOIN work_notifications n ON n.notification_id=a.notification_id
    JOIN work_result_cards c ON c.card_key=n.card_key
    WHERE n.work_id=? AND n.channel=? AND n.target_key=? AND n.card_key<>?
      AND c.kind LIKE 'closure_%'
      AND EXISTS (SELECT 1 FROM work_result_cards current_card WHERE current_card.card_key=?
        AND current_card.intent_revision=c.intent_revision AND current_card.input_snapshot_id=c.input_snapshot_id)
      ORDER BY a.claimed_at DESC,a.rowid DESC`)
    .all(notification.workId,notification.channel ?? "",notification.targetKey ?? "",notification.cardKey,notification.cardKey));
  const states = new Set(prior.map(attempt => {
    if (attempt.status === "unknown") return "原投递回执未知，文件可能已发送，未自动重发";
    let receipt: unknown;
    try { receipt = JSON.parse(attempt.receipt ?? "null"); } catch { receipt = undefined; }
    const parts = z.array(z.object({ part: z.string(), code: z.string().optional() })).safeParse(receipt);
    if (parts.success && parts.data.some(part => part.part === "files" && part.code === "fileunsupported")) return "原渠道不支持文件发送";
    if (attempt.status === "sent") return "原通知已有发送回执，本次不重复投递附件";
    return "原投递尚未确认成功";
  }));
  return `结论更正：经复核，事项成果已完成。此消息仅更正事项结论，不代表文件新送达。\n${[...states].join("；") || "原文件投递没有可确认的回执"}。\n本次不附加或重发文件；核验后的精确文件版本仍可在 MyBuddy 更正结果卡中打开。`;
}
