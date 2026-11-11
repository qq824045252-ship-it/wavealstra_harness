import type Database from "better-sqlite3";
import { resolve } from "node:path";
import type { WorkExecutionBindingDto, WorkDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import type { WorkResultDecision } from "./BotWorkResultTurn";
import { workExecutionObservationSchema } from "../../../shared/bot-work-phase3";
import { watchTimeExpired } from "../../../shared/work-watch-expiry";

export interface WatchGoalEvidence { resultId: string; toolName: string; source: string; observedAt: number; text: string }
/** Raw, bounded native tool receipts. Model-authored summaries are never proof. */
export function watchGoalEvidence(db: Database.Database, works: WorkService, binding: WorkExecutionBindingDto): WatchGoalEvidence[] {
  try { return collectEvidence(db,works,binding); } catch { return []; }
}
function collectEvidence(db: Database.Database, works: WorkService, binding: WorkExecutionBindingDto): WatchGoalEvidence[] {
  const input = JSON.parse(works.repo.executionInput(binding));
  const team = input.teamAssignment;
  if (works.teams.get(binding.workId) && team?.role !== "owner_summary") {
    // A host-issued owner supplement is not an ordinary team member. Its own
    // completed native reads can prove the exact watched condition.
    const work = works.getWork(binding.workId);
    const request = db.prepare("SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?").get(binding.taskId) as {continuation_plan_id:string|null}|undefined;
    const plan = request?.continuation_plan_id && works.partialResults.plans(binding.workId).find(p => p.planId === request.continuation_plan_id);
    const source = plan && works.repo.getBinding(plan.sourceBindingId);
    if (!work || !plan || !source || binding.botId !== work.ownerBotId || plan.ownerBotId !== work.ownerBotId
      || plan.ownerEpoch !== work.ownerEpoch || plan.intentRevision !== work.intentRevision || plan.inputSnapshotId !== work.inputSnapshotId
      || plan.state === "cancelled" || !plan.gapItemIds.length || !plan.gapItemIds.every(id => id.startsWith("watch-followup:"))
      || !works.partialResults.isReadOnlyPlan(plan) || !works.collaboration.isDelegationAdopted(source,work)
      || !works.scheduledBindingCurrent(binding) || binding.delegatedScope.some(scope => scope !== "workspace:read")) return [];
  }
  let ids: string[] = [binding.bindingId];
  if (team?.role === "owner_summary" && team.watchRound) {
    const current = works.teams.get(binding.workId);
    if (!current || current.intentRevision !== binding.intentRevision || current.inputSnapshotId !== binding.inputSnapshotId
      || current.ownerEpoch !== binding.ownerEpoch || !binding.inboxEventId
      || team.watchRound.inbox_event_id !== binding.inboxEventId) return [];
    const expected = current.members.map(member => member.botId);
    const results = team.previousResults as Array<{botId?:string;bindingId?:string}> | undefined;
    if (!results?.length || new Set(expected).size !== expected.length || results.some(r=>!r.botId || !expected.includes(r.botId))) return [];
    ids = [];
    for (const botId of expected) {
      // Supervision may trail the next scheduled round. Select this owner's
      // round, not the mutable current-team projection. Native row order breaks
      // admitted-at ties deterministically for same-round recovery attempts.
      const row = db.prepare(`SELECT binding_id FROM work_execution_bindings
        WHERE work_id=? AND bot_id=? AND inbox_event_id=? AND binding_id<>?
          AND intent_revision=? AND input_snapshot_id=? AND owner_epoch=? AND invalidated_at IS NULL
        ORDER BY admitted_at DESC,rowid DESC LIMIT 1`).get(binding.workId,botId,binding.inboxEventId,
          binding.bindingId,binding.intentRevision,binding.inputSnapshotId,binding.ownerEpoch) as {binding_id:string}|undefined;
      const execution = row && works.repo.getBinding(row.binding_id);
      const claims = results.filter(r=>r.botId === botId);
      // Owner context intentionally retains older attempts for diagnostics. Only
      // the current native binding can prove this member's successful recovery.
      if (!execution?.bindingId || !claims.some(r=>r.bindingId === execution.bindingId)) return [];
      ids.push(execution.bindingId);
    }
    if (new Set(ids).size !== ids.length) return [];
  }
  if (!ids.length) return [];
  const evidence: WatchGoalEvidence[] = [];
  for (const id of ids) {
    const member = works.repo.getBinding(id);
    if (!member || member.workId !== binding.workId || member.status !== "completed" || member.invalidatedAt
      || member.intentRevision !== binding.intentRevision || member.inputSnapshotId !== binding.inputSnapshotId
      || member.ownerEpoch !== binding.ownerEpoch || member.inboxEventId !== binding.inboxEventId) return [];
    const row = db.prepare("SELECT payload_json FROM work_native_inbox WHERE binding_id=? AND consumed_at IS NOT NULL ORDER BY received_at DESC,rowid DESC LIMIT 1").get(id) as {payload_json:string}|undefined;
    // Never reach back past the latest consumed failure/malformed receipt for an
    // older success. A new failure invalidates that execution's current proof.
    const parsed = row && workExecutionObservationSchema.safeParse(JSON.parse(row.payload_json));
    if (!parsed?.success || parsed.data.status !== "completed" || parsed.data.hasWriteConflicts) return [];
    const latest = new Map<string,NonNullable<typeof parsed.data.readEvidence>[number]>();
    const source = (read: NonNullable<typeof parsed.data.readEvidence>[number]) =>
      read.toolName === "read" ? resolve(member.workspaceBinding,read.target) : read.target;
    for (const read of parsed.data.readEvidence ?? []) latest.set(JSON.stringify([read.toolName,source(read)]),read);
    const usable = [...latest.values()].filter(read=>!read.partial && !!read.outputText && /^[a-f0-9]{64}$/.test(read.outputHash));
    if (!usable.length) return [];
    evidence.push(...usable.map(read=>({resultId:`${id}:${read.toolCallId}`,toolName:read.toolName,
      source:source(read),
      observedAt:read.at,text:read.outputText!})));
  }
  return evidence;
}
export function watchGoalMet(work: WorkDto, binding: WorkExecutionBindingDto, decision: WorkResultDecision,
  originalRequest: unknown, evidence: WatchGoalEvidence[], now=Date.now()): boolean {
  const stop=decision.stopAssessment;
  if (work.mode !== "watch" || work.lifecycle !== "active" || watchTimeExpired(work,now)
    || !work.watchRule?.stopConditionText?.trim() || binding.status !== "completed"
    || binding.invalidatedAt || binding.ownerEpoch !== work.ownerEpoch || binding.intentRevision !== work.intentRevision
    || binding.inputSnapshotId !== work.inputSnapshotId || stop?.status !== "met" || decision.outcome !== "completed"
    || stop.conditionExcerpt.trim() !== work.watchRule.stopConditionText.trim() || !stop.requestExcerpt.trim() || !stop.evidence.length) return false;
  const request=originalRequest as {userRequest?:{messages?:{text:string}[]}};
  const userText=request.userRequest?.messages?.map(m=>m.text).join("\n") ?? "";
  if (!userText.includes(stop.requestExcerpt)) return false;
  return stop.evidence.every(proof=>proof.quote.trim() && evidence.some(item=>item.resultId===proof.resultId && (item.text.includes(proof.quote) || JSON.stringify(item.text).slice(1,-1).includes(proof.quote))));
}

export function watchGoalClosureSummary(decision: WorkResultDecision): string {
  return `已根据本轮实际观察确认停止条件满足：${(decision.stopAssessment?.conditionExcerpt ?? "原委托明确的停止条件").replace(/[。；;]+$/, "")}。持续委托已完成，后续不再检查。详细依据见本轮报告。`;
}
