import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

type Row = Record<string, any>;
const VERSION = "work-effect-retirement-v1";
function object(raw: unknown): Row {
  try { const value = typeof raw === "string" ? JSON.parse(raw) : raw; return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
function has(db: Database.Database, table: string, ...fields: string[]): boolean {
  const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
  return names.size > 0 && fields.every(field => names.has(field));
}

/** Diagnostic retirement, not proof of business success or permission to replay.
 * Runs in AppDatabase's migration transaction. Raw evidence and settled history stay intact.
 */
export function retireWorkEffectBlockers(db: Database.Database, now = Date.now()): {
  clearedBlockers: number; consumedAdmissions: number; promotedPlans: number; unknownAdmissions: number;
} {
  const report = { clearedBlockers: 0, consumedAdmissions: 0, promotedPlans: 0, unknownAdmissions: 0 };
  const affectedWorks = new Set<string>();
  const finish = () => {
    if (affectedWorks.size && has(db, "works", "state_version", "updated_at")) {
      const update = db.prepare("UPDATE works SET state_version=state_version+1,updated_at=? WHERE work_id=?");
      for (const workId of affectedWorks) update.run(now, workId);
    }
    return report;
  };
  db.exec(`CREATE TABLE IF NOT EXISTS work_effect_retirement_audit (
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, provenance_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(entity_type,entity_id)
  )`);
  const audit = (type: string, id: string, evidence: Row) => db.prepare(`INSERT OR IGNORE INTO work_effect_retirement_audit
    VALUES (?,?,?,?)`).run(type, id, JSON.stringify({ migration: VERSION, ...evidence }), now);
  if (has(db, "work_blockers", "details_json", "unknown_external_effect_ref", "waiting_for_user_input")) {
    const blockers = db.prepare(`SELECT * FROM work_blockers WHERE status='open'
      AND (kind='external_effect' OR unknown_external_effect_ref IS NOT NULL)`).all() as Row[];
    for (const row of blockers) {
      audit("blocker", row.blocker_id, { original: row, disposition: "continue_without_replay" });
      db.prepare("UPDATE work_blockers SET status='cleared',waiting_for_user_input=0,cleared_at=?,details_json=? WHERE blocker_id=? AND status='open'")
        .run(now, JSON.stringify({ ...object(row.details_json), effectDisposition: "continue_without_replay",
          effectRetirement: { migration: VERSION, businessOutcome: "unverified" } }), row.blocker_id);
      affectedWorks.add(row.work_id);
      report.clearedBlockers++;
    }
  }
  if (has(db, "work_action_admissions") && has(db, "work_execution_bindings")) {
    const orphaned = db.prepare(`SELECT a.* FROM work_action_admissions a JOIN work_execution_bindings b
      ON b.binding_id=a.binding_id AND b.work_id=a.work_id AND b.intent_revision=a.intent_revision AND b.owner_epoch=a.owner_epoch
      WHERE a.state='admitted' AND b.status IN ('completed','failed','stopped','invalidated')`).all() as Row[];
    for (const admission of orphaned) {
      audit("orphaned-admission", admission.admission_id, { original: admission, disposition: "unknown_not_replayable" });
      db.prepare("UPDATE work_action_admissions SET state='unknown' WHERE admission_id=? AND state='admitted'").run(admission.admission_id);
      affectedWorks.add(admission.work_id);
      report.unknownAdmissions++;
    }
  }
  if (has(db, "execution_attempts") && has(db, "work_action_admissions") && has(db, "work_execution_bindings")) {
    const candidates = db.prepare(`SELECT a.*,b.task_id,b.conversation_id FROM work_action_admissions a
      JOIN work_execution_bindings b ON b.binding_id=a.binding_id AND b.work_id=a.work_id
      AND b.intent_revision=a.intent_revision AND b.owner_epoch=a.owner_epoch WHERE a.state='unknown'`).all() as Row[];
    for (const admission of candidates) {
      const attempts = db.prepare("SELECT * FROM execution_attempts WHERE task_id=? AND status='failed'").all(admission.task_id) as Row[];
      for (const attempt of attempts) {
        const record = object(attempt.record_json), proof = object(record.verification), observed = object(proof.observed);
        const prefix = `durable:${admission.task_id}:${admission.conversation_id}:`;
        if (!attempt.execution_id.startsWith(prefix)) continue;
        const nativeId = attempt.execution_id.slice(prefix.length);
        if (!nativeId || admission.operation_id !== `tool:${admission.conversation_id}:${nativeId}:${attempt.tool_call_id}`) continue;
        const expectedId = `attempt-durable-${createHash("sha256").update(JSON.stringify([
          attempt.task_id, attempt.execution_id, attempt.assistant_message_id, attempt.tool_call_id,
        ])).digest("hex")}`;
        if (attempt.id !== expectedId || record.id !== attempt.id || record.taskId !== attempt.task_id
          || record.executionId !== attempt.execution_id || record.assistantMessageId !== attempt.assistant_message_id
          || record.toolCallId !== attempt.tool_call_id || record.target !== attempt.target
          || record.status !== "failed" || record.phase !== "finished" || !Number.isFinite(attempt.finished_at)
          || proof.attemptId !== attempt.id || proof.taskId !== attempt.task_id || proof.executionId !== attempt.execution_id
          || proof.assistantMessageId !== attempt.assistant_message_id || proof.target !== attempt.target
          || proof.status !== "failed" || proof.verifierId !== record.verifierId || proof.verifierVersion !== record.verifierVersion
          || !Number.isFinite(proof.checkedAt) || proof.checkedAt < record.startedAt) continue;
        const codes = observed.diagnosticCodes;
        if (!Array.isArray(codes) || (!codes.includes("exit_code") && observed.completedResponse !== true)
          || observed.notStarted === true
          || codes.some(code => ["interrupted", "aborted", "abandoned", "restart_limit", "tool_error"].includes(code))) continue;
        audit("admission", admission.admission_id, { original: admission, attemptId: attempt.id,
          evidence: "returned_exit_code", businessOutcome: "failed", disposition: "consumed_not_success" });
        db.prepare("UPDATE work_action_admissions SET state='consumed',settled_at=COALESCE(settled_at,?) WHERE admission_id=? AND state='unknown'")
          .run(attempt.finished_at, admission.admission_id);
        affectedWorks.add(admission.work_id);
        report.consumedAdmissions++;
        break;
      }
    }
  }
  // Reflect proven returned failures only for exact admission references in the same Work.
  // The raw reason/ref and original blocker remain available in the audit ledger.
  if (has(db, "work_blockers", "details_json", "unknown_external_effect_ref") && has(db, "work_action_admissions")) {
    const proven = db.prepare(`SELECT b.* FROM work_blockers b
      JOIN work_action_admissions a ON a.admission_id=b.unknown_external_effect_ref AND a.work_id=b.work_id AND a.state='consumed'
      JOIN work_effect_retirement_audit evidence ON evidence.entity_type='admission' AND evidence.entity_id=a.admission_id
      WHERE b.status='cleared' AND json_extract(evidence.provenance_json,'$.businessOutcome')='failed'`).all() as Row[];
    for (const blocker of proven) {
      const details = object(blocker.details_json);
      if (details.effectRetirement?.migration !== VERSION || details.effectRetirement.businessOutcome === "failed") continue;
      db.prepare("UPDATE work_blockers SET details_json=? WHERE blocker_id=?").run(JSON.stringify({ ...details,
        effectRetirement: { ...details.effectRetirement, businessOutcome: "failed" } }), blocker.blocker_id);
      affectedWorks.add(blocker.work_id);
    }
  }
  // Optional tables are initialized by WorkService, and may not exist on first boot.
  if (!["work_automatic_recovery", "work_continuation_plans", "works", "tasks", "work_execution_bindings", "work_blockers"]
    .every(table => has(db, table)) || !has(db, "work_dispatch_requests", "continuation_plan_id")
    || !has(db, "work_execution_bindings", "inbox_event_id")) return finish();
  const plans = db.prepare(`SELECT r.*,p.work_id,p.reason FROM work_automatic_recovery r
    JOIN work_continuation_plans p ON p.plan_id=r.plan_id AND p.source_binding_id=r.source_binding_id
    JOIN work_execution_bindings b ON b.binding_id=r.source_binding_id AND b.work_id=p.work_id
    JOIN works w ON w.work_id=p.work_id JOIN tasks t ON t.id=b.task_id
    WHERE r.mode='readback' AND p.state='pending' AND r.plan_id='automatic-recovery:' || b.binding_id
      AND w.lifecycle='active' AND w.cancel_requested_at IS NULL AND w.pending_conclusion IS NULL
      AND b.status='failed' AND b.invalidated_at IS NULL AND b.inbox_event_id IS NULL
      AND b.bot_id=w.owner_bot_id AND b.owner_epoch=w.owner_epoch AND p.owner_epoch=w.owner_epoch
      AND p.owner_bot_id=w.owner_bot_id AND b.intent_revision=w.intent_revision AND p.intent_revision=w.intent_revision
      AND b.input_snapshot_id=w.input_snapshot_id AND p.input_snapshot_id=w.input_snapshot_id
      AND t.permission_mode='auto' AND b.delegated_scope_json='[]'
      AND NOT EXISTS (SELECT 1 FROM work_dispatch_requests d WHERE d.continuation_plan_id=p.plan_id)
      AND NOT EXISTS (SELECT 1 FROM work_dispatch_requests d WHERE d.task_id=b.task_id AND d.continuation_plan_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM work_automatic_recovery older JOIN work_execution_bindings ob ON ob.binding_id=older.source_binding_id
        WHERE ob.work_id=b.work_id AND ob.intent_revision=b.intent_revision AND ob.input_snapshot_id=b.input_snapshot_id
          AND older.source_binding_id!=r.source_binding_id AND older.fingerprint=r.fingerprint)
      AND EXISTS (SELECT 1 FROM work_blockers blocker JOIN work_effect_retirement_audit a
        ON a.entity_type='blocker' AND a.entity_id=blocker.blocker_id WHERE blocker.work_id=p.work_id
          AND blocker.created_at<=r.created_at AND json_extract(a.provenance_json,'$.original.status')='open')
      AND NOT EXISTS (SELECT 1 FROM work_blockers blocker WHERE blocker.work_id=p.work_id AND blocker.status='open')`).all() as Row[];
  for (const plan of plans) {
    audit("recovery", plan.plan_id, { original: plan, disposition: "continue_without_replay" });
    db.prepare("UPDATE work_automatic_recovery SET mode='recover' WHERE plan_id=? AND mode='readback'").run(plan.plan_id);
    // Preserve original plan/subitem wording as history. Host recovery instructions select the mode.
    affectedWorks.add(plan.work_id);
    report.promotedPlans++;
  }
  return finish();
}
