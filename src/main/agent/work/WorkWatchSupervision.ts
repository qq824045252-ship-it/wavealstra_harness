import { createHash } from "node:crypto";
import { WorkWatchFollowUp } from "./WorkWatchFollowUp";
import { previousWatchObservations } from "./WorkWatchComparison";
import { watchGoalEvidence, watchGoalMet, watchNotificationNotMet, watchNotificationArtifactEvidence, watchGoalClosureSummary } from "./WorkWatchGoal";
import { completionArtifactEvidence, type WorkCompletionOptions } from "./WorkCompletionCoordinator";
import type { WorkResultDecision } from "./BotWorkResultTurn";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { watchTimeExpired } from "../../../shared/work-watch-expiry";
import { watchObservationDelivery, watchTeamReadEvidence, type WatchObservationPresentation } from "./WorkWatchObservation";

export const WATCH_EXECUTION_RISK_LIMIT = 40;

/** A durable, independent owner review per observation. A round never closes the
 * standing commission, and reviewing a receipt never repeats its business effects. */
export class WorkWatchSupervision {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Set<string>();
  private closed = false;
  private readonly followUp: WorkWatchFollowUp;
  constructor(private readonly options: WorkCompletionOptions) {
    this.followUp = new WorkWatchFollowUp(options);
    options.db.exec(`CREATE TABLE IF NOT EXISTS work_watch_reviews (
      binding_id TEXT PRIMARY KEY, context_json TEXT NOT NULL, decision_json TEXT,
      state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, reviewed_at INTEGER)`);
  }
  start(): void { if (this.timer) return; this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake(); }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); }
  wake(): void {
    if (this.closed || !this.options.isAuthority()) return;
    for (const row of this.options.db.prepare("SELECT DISTINCT work_id FROM work_blockers INDEXED BY uq_work_blocker_reason WHERE status='open' AND reason_code IS NOT NULL AND reason_code IN ('invalid-schedule','user-input') AND blocker_id LIKE 'watch-next-step:%'").all() as {work_id:string}[])
      this.options.works.transaction(()=>this.reconcileNextStepBlockers(row.work_id));
    for (const row of this.options.db.prepare("SELECT r.binding_id,b.work_id,r.decision_json FROM work_watch_reviews r JOIN work_execution_bindings b ON b.binding_id=r.binding_id WHERE r.state='finishing'").all() as {binding_id:string;work_id:string;decision_json:string}[]) {
      this.options.works.transaction(()=>{
        const work=this.options.works.getWork(row.work_id),binding=this.options.works.repo.getBinding(row.binding_id);
        if (!work || !binding || work.lifecycle !== 'closing' || work.pendingConclusion || work.watchRule?.termination
          || binding.invalidatedAt || binding.intentRevision!==work.intentRevision || binding.inputSnapshotId!==work.inputSnapshotId || binding.ownerEpoch!==work.ownerEpoch) {
          this.options.db.prepare("UPDATE work_watch_reviews SET state='superseded' WHERE binding_id=?").run(row.binding_id); return;
        }
        if (!this.hasPending(row.work_id) && this.options.works.settleReviewedWatchCompletion(row.work_id,row.binding_id,watchGoalClosureSummary(JSON.parse(row.decision_json),work)))
          this.options.db.prepare("UPDATE work_watch_reviews SET state='delivered' WHERE binding_id=?").run(row.binding_id);
      });
    }
    const rows = this.options.db.prepare(`WITH pending AS (SELECT b.binding_id,b.work_id,b.admitted_at,r.retry_at,
        ROW_NUMBER() OVER (PARTITION BY b.work_id ORDER BY b.admitted_at,b.rowid) ordinal FROM work_execution_bindings b
      JOIN works w ON w.work_id=b.work_id LEFT JOIN work_watch_reviews r ON r.binding_id=b.binding_id
      WHERE w.mode='watch' AND w.lifecycle IN ('active','paused','closing') AND (b.bot_id=w.owner_bot_id OR (w.lifecycle='closing' AND EXISTS (SELECT 1 FROM work_team_executions e WHERE e.work_id=w.work_id AND e.task_id=b.task_id)
        AND NOT EXISTS (SELECT 1 FROM work_team_executions owner JOIN work_execution_bindings ob ON ob.task_id=owner.task_id
          WHERE owner.work_id=w.work_id AND owner.role='owner_summary')))
      AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id
      AND b.owner_epoch=w.owner_epoch AND b.invalidated_at IS NULL
      AND b.status IN ('completed','failed','stopped')
      AND (r.binding_id IS NULL OR r.state='queued')
      AND (r.binding_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM bot_work_feedback f
        WHERE json_extract(f.metadata_json,'$.executionId')=b.binding_id
        AND json_extract(f.metadata_json,'$.kind')='result'
        AND COALESCE(json_extract(f.metadata_json,'$.eventId'),'') NOT LIKE 'reminder-%'))
      AND (b.status<>'completed' OR EXISTS (SELECT 1 FROM work_native_inbox n WHERE n.binding_id=b.binding_id AND n.consumed_at IS NOT NULL))
      ) SELECT binding_id,work_id,retry_at FROM pending WHERE ordinal=1
      ORDER BY COALESCE(retry_at,0),admitted_at LIMIT 128`).all() as Array<{binding_id:string;work_id:string;retry_at:number|null}>;
    const seen = new Set<string>();
    for (const row of rows) {
      if (this.active.size >= 2) break;
      if (seen.has(row.work_id)) continue;
      seen.add(row.work_id);
      if ((row.retry_at ?? 0) > Date.now() || [...this.active].some(id => this.options.works.repo.getBinding(id)?.workId === row.work_id)) continue;
      if (this.active.has(row.binding_id)) continue;
      this.active.add(row.binding_id);
      void this.process(row.binding_id).catch(error => {
        if (!this.closed && this.options.isAuthority()) this.recordFailure(row.binding_id,error);
        console.warn('[Work] 持续委托结果整理等待重试', error);
      })
        .finally(() => this.active.delete(row.binding_id));
    }
  }
  /** Only this lane's missing-next-step diagnostics expire when a real plan exists.
   * Source failures, other modules' schedule errors and unknown effects are untouched. */
  private reconcileNextStepBlockers(workId: string, scheduled=false): void {
    const {works}=this.options,work=works.getWork(workId);if(!work)return;
    const finished=work.lifecycle==='closing'||work.lifecycle==='closed';
    const planned=scheduled || works.repo.listSubscriptions(workId).some(sub=>!sub.stoppedAt &&
      (sub.nextWakeAt!==undefined && sub.nextWakeAt>Date.now() || sub.source!=='cron' && works.ingress.availableEventSources().some(adapter=>adapter.source===sub.source)))
      || works.partialResults.plans(workId).some(plan=>!['cancelled','settled'].includes(plan.state));
    for(const blocker of works.repo.listOpenBlockers(workId)) if(blocker.blockerId.startsWith('watch-next-step:')
      && blocker.kind==='operational' && !blocker.unknownExternalEffectRef
      && (finished || planned && blocker.reasonCode==='invalid-schedule')) works.repo.clearBlocker(blocker.blockerId,workId,Date.now());
  }
  private recordFailure(id: string, error: unknown): void {
    const {db} = this.options;
    db.prepare(`INSERT INTO work_watch_reviews(binding_id,context_json,attempts,retry_at,error) VALUES (?,'{}',1,?,?)
      ON CONFLICT(binding_id) DO UPDATE SET attempts=attempts+1,retry_at=excluded.retry_at,error=excluded.error`)
      .run(id,Date.now()+15000,String(error));
    const row = db.prepare('SELECT attempts,decision_json FROM work_watch_reviews WHERE binding_id=?').get(id) as {attempts:number;decision_json:string|null};
    if (row.attempts < 2 || row.decision_json) return;
    const current = this.snapshot(id); if (!current) return;
    const raw = current.results.map(r=>r.summary).join('\n\n') || current.binding.settlementNote || '本轮没有可用结果正文';
    if (this.options.deliver({bindingId:id,eventId:`watch-supervision:${id}`,category:'result',text:raw,
      notices:['前台整理未完成，先交付原始结果；没有重跑本轮业务。',String(error)]}))
      db.prepare("UPDATE work_watch_reviews SET state='delivered',reviewed_at=? WHERE binding_id=?").run(Date.now(),id);
  }
  hasPending(workId: string): boolean {
    return Boolean(this.options.db.prepare(`SELECT 1 FROM work_execution_bindings b
      JOIN works w ON w.work_id=b.work_id LEFT JOIN work_watch_reviews r ON r.binding_id=b.binding_id
      WHERE b.work_id=? AND (b.bot_id=w.owner_bot_id OR (w.lifecycle='closing' AND EXISTS (SELECT 1 FROM work_team_executions e WHERE e.work_id=w.work_id AND e.task_id=b.task_id)
        AND NOT EXISTS (SELECT 1 FROM work_team_executions owner JOIN work_execution_bindings ob ON ob.task_id=owner.task_id
          WHERE owner.work_id=w.work_id AND owner.role='owner_summary'))) AND b.owner_epoch=w.owner_epoch
      AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id AND b.invalidated_at IS NULL AND b.status IN ('completed','failed','stopped')
      AND (r.binding_id IS NULL OR r.state='queued')
      AND NOT EXISTS (SELECT 1 FROM bot_work_feedback f WHERE json_extract(f.metadata_json,'$.executionId')=b.binding_id
        AND json_extract(f.metadata_json,'$.kind')='result'
        AND COALESCE(json_extract(f.metadata_json,'$.eventId'),'') NOT LIKE 'reminder-%') LIMIT 1`).get(workId));
  }
  /** A watch-only supplementary round that is already queued is still a pending
   * obligation; a proven-unchanged round must not settle around it. */
  private hasPendingFollowUp(workId: string): boolean {
    return this.options.works.partialResults.plans(workId).some(plan => plan.state !== 'cancelled' && plan.state !== 'settled'
      && plan.gapItemIds.length > 0 && plan.gapItemIds.every(id => id.startsWith('watch-followup:')));
  }
  /** Continuous work may reuse a reviewed result only when no actionable responsibility remains. */
  private continuousRoundComplete(binding: WorkExecutionBindingDto, work: WorkDto): boolean {
    const {works,db}=this.options;
    if (works.partialResults.gaps(work.workId).length || works.repo.listOpenBlockers(work.workId).length
      || works.partialResults.plans(work.workId).some(plan=>!['cancelled','settled'].includes(plan.state))) return false;
    if (!works.repo.listSubscriptions(work.workId).some(sub=>!sub.stoppedAt &&
      (sub.nextWakeAt !== undefined && sub.nextWakeAt > Date.now() || sub.source !== 'cron' && works.ingress.availableEventSources().some(adapter=>adapter.source===sub.source)))) return false;
    if (works.repo.listAdmissions(work.workId).some(admission=>['admitted','attempted','unknown'].includes(admission.state))) return false;
    const results=works.repo.listDeliverables(work.workId).filter(result=>result.executionId===binding.bindingId && result.status!=='superseded' && result.status!=='rejected');
    if (!results.length || results.some(result=>result.isSpeculation || result.hasWriteConflicts || result.uncoveredScope.length || result.uncoveredCriterionIds.length)) return false;
    const previous=db.prepare(`SELECT r.context_json,r.decision_json,r.error FROM work_watch_reviews r
      JOIN work_execution_bindings b ON b.binding_id=r.binding_id
      WHERE b.work_id=? AND b.binding_id<>? AND b.intent_revision=? AND b.input_snapshot_id=? AND b.owner_epoch=?
        AND b.invalidated_at IS NULL AND r.state IN ('silent','delivered') AND r.decision_json IS NOT NULL
      ORDER BY r.reviewed_at DESC,r.rowid DESC LIMIT 1`).get(work.workId,binding.bindingId,work.intentRevision,work.inputSnapshotId,work.ownerEpoch) as {context_json:string;decision_json:string;error:string|null}|undefined;
    if (!previous || previous.error) return false;
    try {
      const decision=JSON.parse(previous.decision_json) as WorkResultDecision;
      const context=JSON.parse(previous.context_json) as {watchRule?:unknown;artifactEvidence?:ReturnType<typeof completionArtifactEvidence>};
      if (decision.decision!=='deliver' || decision.outcome!=='completed' || decision.missing.length || decision.followUp || decision.waitPlan
        || decision.notificationAssessment?.status === 'unknown' || ['unknown','met'].includes(decision.stopAssessment?.status ?? '') || JSON.stringify(context.watchRule)!==JSON.stringify(work.watchRule)) return false;
      const current=completionArtifactEvidence(works,binding);
      if (!context.artifactEvidence || [...current,...context.artifactEvidence].some(item=>item.state!=='text' || item.truncated || item.omittedEvidenceCount)) return false;
      const fingerprints=(items:typeof current)=>items.map(item=>[item.name,item.registeredDigest,item.registeredSizeBytes]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return JSON.stringify(fingerprints(current))===JSON.stringify(fingerprints(context.artifactEvidence));
    } catch { return false; }
  }
  /** Host-owned proof that this round adds nothing to understand: the comparison
   * is unchanged, the changes_only policy is silent, and no fact that could alter
   * the judgement (lifecycle, expiry, follow-up, question, preference/goal
   * version) moved. Then the reviewed baseline already answered this round, so a
   * second result-model turn is pure overhead. Never a model's claimed silence. */
  private hostProvenUnchanged(binding: WorkExecutionBindingDto, work: WorkDto,
    presentation: WatchObservationPresentation, preferenceFingerprint: string): boolean {
    if (presentation.comparisonState !== 'unchanged' || !presentation.silent) return false;
    if (binding.status !== 'completed' || work.lifecycle !== 'active' || this.executionRisks(binding).items.length) return false;
    const rule = work.watchRule;
    if (!rule || rule.requestedOutcome === 'one_time' || rule.notificationMode !== 'changes_only') return false;
    if (rule.executionMode === 'continuous' && !this.continuousRoundComplete(binding,work)) return false;
    if (rule.termination || (rule.endsAt !== undefined && watchTimeExpired(work, Date.now()))) return false;
    if (work.pendingConclusion || work.cancelRequestedAt) return false;
    if (this.hasPendingFollowUp(work.workId)) return false;
    if (this.options.works.repo.listOpenBlockers(work.workId).some(blocker => blocker.waitingForUserInput)) return false;
    // A cached verdict or a failed delivery must finish through its own path.
    if (this.options.db.prepare("SELECT 1 FROM work_watch_reviews WHERE binding_id=? AND (decision_json IS NOT NULL OR state<>'queued')").get(binding.bindingId)) return false;
    const prior = this.options.db.prepare(`SELECT r.context_json FROM work_watch_reviews r
      JOIN work_execution_bindings b ON b.binding_id=r.binding_id
      WHERE b.work_id=? AND r.binding_id<>? AND r.state IN ('silent','delivered')
        AND json_extract(r.context_json,'$.watchSupervision')=1
      ORDER BY r.reviewed_at DESC,r.rowid DESC LIMIT 1`).get(work.workId,binding.bindingId) as {context_json:string}|undefined;
    if (!prior) return false;
    try {
      const previous = JSON.parse(prior.context_json) as {preferenceFingerprint?:unknown;
        watchRule?:{notificationMode?:unknown;notifyInitial?:unknown;stopConditionText?:unknown}};
      // Same personal-preference and watcher-policy version as the reviewed round.
      return previous.preferenceFingerprint === preferenceFingerprint
        && previous.watchRule?.notificationMode === rule.notificationMode
        && previous.watchRule?.notifyInitial === rule.notifyInitial
        && (previous.watchRule?.stopConditionText ?? null) === (rule.stopConditionText ?? null);
    } catch { return false; }
  }
  private executionRisks(binding: WorkExecutionBindingDto) {
    const {works}=this.options,bindings=works.repo.listBindings(binding.workId);
    const lineage=works.partialResults.recovery.ancestry(binding).map(item=>item.bindingId);
    const operations=works.repo.listAdmissions(binding.workId).filter(item=>['admitted','attempted','unknown'].includes(item.state)).map(item=>{
      const source=bindings.find(candidate=>candidate.bindingId===item.bindingId);
      return {riskId:item.admissionId,operationId:item.operationId,actionKind:item.actionKind,state:item.state,bindingId:item.bindingId,
        intentRevision:item.intentRevision,ownerEpoch:item.ownerEpoch,invalidatedAt:source?.invalidatedAt,
        currentLineage:!!item.bindingId&&lineage.includes(item.bindingId),retired:!!source?.invalidatedAt&&item.state!=='admitted'&&!lineage.includes(source.bindingId)};
    });
    const executions=bindings.filter(item=>['pending','submitted','running','unknown'].includes(item.status)).map(item=>({riskId:`execution:${item.bindingId}`,
      operationId:item.operationId,actionKind:'execution',state:item.status,bindingId:item.bindingId,intentRevision:item.intentRevision,
      ownerEpoch:item.ownerEpoch,invalidatedAt:item.invalidatedAt,currentLineage:lineage.includes(item.bindingId),retired:!!item.invalidatedAt&&!lineage.includes(item.bindingId)}));
    const all=[...operations,...executions];
    return {lineage:lineage.slice(0,WATCH_EXECUTION_RISK_LIMIT),omittedLineageCount:Math.max(0,lineage.length-WATCH_EXECUTION_RISK_LIMIT),
      items:all.slice(0,WATCH_EXECUTION_RISK_LIMIT),omittedRiskCount:Math.max(0,all.length-WATCH_EXECUTION_RISK_LIMIT),
      fingerprint:createHash('sha256').update(JSON.stringify([lineage,all])).digest('hex')};
  }
  private independentPriorRisks(risks: ReturnType<WorkWatchSupervision['executionRisks']>,decision: WorkResultDecision,
    originalRequest: unknown,evidence: ReturnType<typeof watchGoalEvidence>): boolean {
    if(!risks.omittedRiskCount && !risks.items.length)return true;
    if(risks.omittedRiskCount || risks.omittedLineageCount)return false;
    const assessment=decision.priorRiskAssessment;
    if(risks.items.some(item=>!item.retired) || assessment?.status!=='independent' || !assessment.reason.trim()
      || assessment.riskIds.length!==risks.items.length || !risks.items.every(item=>assessment.riskIds.includes(item.riskId)))return false;
    const text=(originalRequest as {userRequest?:{messages?:{text:string}[]}}).userRequest?.messages?.map(message=>message.text).join('\n')??'';
    return !!assessment.requestExcerpt.trim() && text.includes(assessment.requestExcerpt) && assessment.evidence.length>0
      && assessment.evidence.every(proof=>proof.quote.trim()&&evidence.some(item=>item.resultId===proof.resultId&&item.text.includes(proof.quote)));
  }
  private snapshot(id: string) {
    const {works} = this.options;
    const binding = works.repo.getBinding(id);
    const work = binding && works.getWork(binding.workId);
    if (!binding || !work || work.mode !== 'watch' || !['active','paused','closing'].includes(work.lifecycle)
      || binding.invalidatedAt || binding.ownerEpoch !== work.ownerEpoch || binding.intentRevision !== work.intentRevision
      || binding.inputSnapshotId !== work.inputSnapshotId) return;
    const results = works.repo.listDeliverables(work.workId).filter(r => r.executionId === id && r.status !== 'superseded');
    const prior = works.repo.previousWatchReports(binding, work.watchRule?.notificationMode === 'changes_only');
    const rawEvidence = watchGoalEvidence(this.options.db,works,binding);
    const previousVerifiedObservations = previousWatchObservations(this.options.db,works,binding,rawEvidence);
    const result = results.find(r => r.deliverableId === `result:${id}`);
    const presentation: WatchObservationPresentation = result ? watchObservationDelivery(work,result,[...prior,result],
      item => watchTeamReadEvidence(this.options.db,works.repo,works.repo.getBinding(item.executionId),item))
      : {silent:false,comparisonState:prior.length ? 'unverified' : 'no_baseline',summary:binding.settlementNote || '本轮没有返回可用结果'};
    const teamContinuationTargets = work.watchRule?.executionMode === "continuous" ? works.teams.continuationTargets(binding) : [];
    const personalPreferences = this.options.preferences?.(binding.taskId) ?? "";
    const preferenceFingerprint = createHash("sha256").update(personalPreferences).digest("hex");
    const executionRisks=this.executionRisks(binding);
    const evidence = JSON.stringify([executionRisks,'watch-comparison-v3-notification-artifacts',teamContinuationTargets,preferenceFingerprint,work.watchRule,rawEvidence,previousVerifiedObservations,presentation,
      [...prior,...results].map(r => [r.deliverableId,r.summary,r.status,r.uncoveredScope,r.artifactRefs,r.isSpeculation,r.hasWriteConflicts])]);
    return {binding,work,results,prior,presentation,evidence,executionRisks,rawEvidence,teamContinuationTargets,previousVerifiedObservations,personalPreferences,preferenceFingerprint};
  }
  private async process(id: string): Promise<void> {
    const {works,db} = this.options;
    const current = this.snapshot(id); if (!current) return;
    const {binding,work,results,prior,presentation,evidence,rawEvidence,previousVerifiedObservations,personalPreferences,preferenceFingerprint} = current;
    // A later observation stopped because the goal was already proven is not a
    // new failed goal. Keep its native receipt in details without another model
    // verdict/message contradicting the accepted round.
    if (work.lifecycle === 'closing' && binding.status === 'stopped'
      && db.prepare("SELECT 1 FROM work_watch_reviews r JOIN work_execution_bindings b ON b.binding_id=r.binding_id WHERE b.work_id=? AND r.state='finishing'").get(work.workId)) {
      db.prepare("INSERT INTO work_watch_reviews(binding_id,context_json,state,reviewed_at) VALUES (?,?,'silent',?) ON CONFLICT(binding_id) DO UPDATE SET state='silent',reviewed_at=excluded.reviewed_at")
        .run(id,JSON.stringify({reason:'later_observation_stopped_after_goal_met',evidence}),Date.now());
      return;
    }
    // Native receipt consumption and its aggregate result commit together.
    if (binding.status === 'completed' && !db.prepare('SELECT 1 FROM work_native_inbox WHERE binding_id=? AND consumed_at IS NOT NULL').get(id)) return;
    // §6 unchanged fast path: the host already proved this round equals the
    // reviewed baseline under changes_only. Persist that provenance as silence
    // and return before any result-model turn or user delivery.
    if (this.hostProvenUnchanged(binding,work,presentation,preferenceFingerprint)) {
      const reviewedAt = Date.now();
      const context = {watchSupervision:true,reason:'host_proven_unchanged',comparisonState:presentation.comparisonState,
        hostProvenUnchanged:true,preferenceFingerprint,watchRule:work.watchRule,
        notificationMode:work.watchRule?.notificationMode ?? null,baselineResultId:presentation.baselineResultId ?? null,
        lifecycle:work.lifecycle,observedAt:binding.settledAt ?? null,reviewedAt,evidence,
        notice:'宿主已证明本轮与既有基线一致且在仅变化时通知模式下静默：未调用结果整理，未向用户投递。'};
      db.prepare(`INSERT INTO work_watch_reviews(binding_id,context_json,state,reviewed_at) VALUES (?,?,'silent',?)
        ON CONFLICT(binding_id) DO UPDATE SET context_json=excluded.context_json,state='silent',reviewed_at=excluded.reviewed_at,
          decision_json=NULL,error=NULL,retry_at=0`).run(id,JSON.stringify(context),reviewedAt);
      return;
    }
    const artifactEvidence = completionArtifactEvidence(works,binding);
    const notificationArtifactEvidence = watchNotificationArtifactEvidence(binding,artifactEvidence,works);
    const source = JSON.parse(works.repo.executionInput(binding));
    const {instructions:_instructions,teamAssignment:_assignment,...originalRequest} = source;
    const baseline = prior.find(r => r.deliverableId === presentation.baselineResultId);
    const context = {watchSupervision:true,executionMode:work.watchRule?.executionMode,preferenceFingerprint,teamRound:source.teamAssignment?.watchRound?.sequence,originalRequest,title:work.title,goal:work.goalDescription,
      watchRule:work.watchRule,lifecycle:work.lifecycle,
      availableEventSources:works.ingress.availableEventSources().map(item=>({source:item.source,namespace:item.namespace})),
      nextWakeAt:works.repo.listSubscriptions(work.workId).filter(s => !s.stoppedAt).map(s => s.nextWakeAt).filter(Boolean),
      observedAt:binding.settledAt, reviewAt:Date.now(), executionStatus:binding.status,
      results:results.map(r=>({summary:r.summary,artifactRefs:r.artifactRefs,uncoveredScope:r.uncoveredScope})),
      executionRisks:current.executionRisks,
      verifiedObservations:rawEvidence,
      artifactEvidence,notificationArtifactEvidence,
      teamContinuationTargets:current.teamContinuationTargets,
      previousVerifiedObservations,
      teamPartialResults: source.teamAssignment?.role === 'owner_summary' && (binding.status !== 'completed' || !results.length)
        ? {notice:'负责人本轮未完成，下列仅为本轮成员已结算的部分依据，不代表全队完成', results:source.teamAssignment.previousResults ?? []} : undefined,
      previousResults:prior.slice(-3).map(r=>({deliverableId:r.deliverableId,summary:r.summary,createdAt:r.createdAt})),
      observationSummary:presentation.summary, comparisonState:presentation.comparisonState,
      comparisonBaseline:baseline ? {deliverableId:baseline.deliverableId,summary:baseline.summary,createdAt:baseline.createdAt} : undefined,
      hostProvenUnchanged:presentation.comparisonState === 'unchanged',
      followUpAvailability:this.followUp.availability(work,binding),
      notificationMode:work.watchRule?.notificationMode ?? 'every_check',
      nextAction:work.lifecycle==='active' ? '本轮观察不完整时可提出原委托内只读 followUp，由宿主持久补查并再次核对，不改变周期；否则按已保存的周期继续下一轮；如用户明确的可观察停止条件已由本轮真实证据满足，提交 stopAssessment 由宿主结束，否则继续' : work.lifecycle==='closing' ? '已停止新轮，整理末轮结果，说明正在收尾；不承诺下一轮' : '已暂停，只整理已发生的本轮观察，不承诺下一轮', evidence};
    db.prepare('INSERT OR IGNORE INTO work_watch_reviews(binding_id,context_json) VALUES (?,?)').run(id,JSON.stringify(context));
    db.prepare("UPDATE work_watch_reviews SET context_json=?,decision_json=NULL WHERE binding_id=? AND (json_extract(context_json,'$.evidence') IS NOT ? OR json_extract(context_json,'$.artifactEvidence') IS NOT ? OR json_extract(context_json,'$.notificationArtifactEvidence') IS NOT ?)").run(JSON.stringify(context),id,evidence,JSON.stringify(artifactEvidence),JSON.stringify(notificationArtifactEvidence));
    const row = db.prepare('SELECT * FROM work_watch_reviews WHERE binding_id=?').get(id) as {context_json:string;decision_json:string|null;attempts:number;error:string|null};
    const attempt = row.attempts > 0 && !row.error && !row.decision_json ? row.attempts : row.attempts+1;
    db.prepare('UPDATE work_watch_reviews SET attempts=?,error=NULL WHERE binding_id=?').run(attempt,id);
    let decision: WorkResultDecision;
    let error: string | undefined;
    try {
      decision = row.decision_json ? JSON.parse(row.decision_json) : await this.options.review({eventId:`watch-review:${id}:${attempt}:${createHash("sha256").update(JSON.stringify([evidence,artifactEvidence,notificationArtifactEvidence])).digest("hex")}`,botId:work.ownerBotId,personalPreferences,context});
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      if (attempt < 2) {
        db.prepare('UPDATE work_watch_reviews SET retry_at=?,error=? WHERE binding_id=?').run(Date.now()+15000,error,id);
        return;
      }
      decision = {decision:'deliver',outcome:'unknown',missing:[],reply:`${presentation.summary}\n\n本轮前台整理失败，以上是原始观察；后续关注计划保持不变。`};
    }
    if (this.closed || !this.options.isAuthority()) return;
    const fresh = this.snapshot(id);
    if (!fresh) return;
    const refreshedArtifacts=completionArtifactEvidence(works,binding);
    if (fresh.evidence !== evidence || fresh.work.lifecycle !== work.lifecycle
      || JSON.stringify(refreshedArtifacts) !== JSON.stringify(artifactEvidence)
      || JSON.stringify(watchNotificationArtifactEvidence(binding,refreshedArtifacts,works)) !== JSON.stringify(notificationArtifactEvidence)) {
      db.prepare('UPDATE work_watch_reviews SET decision_json=NULL,attempts=0,error=NULL,retry_at=0 WHERE binding_id=?').run(id); return;
    }
    // Preserve the expensive model verdict independently of delivery retries.
    db.prepare('UPDATE work_watch_reviews SET decision_json=?,error=? WHERE binding_id=?').run(JSON.stringify(decision),error??null,id);
    works.transaction(()=>{
      const latest = this.snapshot(id); if (!latest) return;
      if (latest.evidence !== evidence || latest.work.lifecycle !== work.lifecycle
        || JSON.stringify(watchNotificationArtifactEvidence(binding,artifactEvidence,works)) !== JSON.stringify(notificationArtifactEvidence)) {
        db.prepare('UPDATE work_watch_reviews SET context_json=?,decision_json=NULL,retry_at=0 WHERE binding_id=?').run(JSON.stringify(context),id); return;
      }
      db.prepare('UPDATE work_watch_reviews SET decision_json=?,error=? WHERE binding_id=?').run(JSON.stringify(decision),error??null,id);
      // Unchanged silence uses host equality; conditional silence additionally binds
      // the existing reviewer verdict to exact user text and current native evidence.
      if (!error) this.followUp.settle(binding,decision);
      const oneTimeMet = latest.work.watchRule?.requestedOutcome === 'one_time' && latest.work.lifecycle === 'active'
        && latest.binding.status === 'completed' && decision.decision === 'deliver' && decision.outcome === 'completed'
        && !decision.missing.length && !decision.followUp && !decision.waitPlan
        && !works.repo.listOpenBlockers(work.workId).some(blocker=>!(blocker.blockerId.startsWith('watch-next-step:') && blocker.reasonCode==='invalid-schedule' && blocker.kind==='operational' && !blocker.unknownExternalEffectRef)) && !works.partialResults.gaps(work.workId).length
        && !works.partialResults.plans(work.workId).some(plan=>!['cancelled','settled'].includes(plan.state))
        && this.independentPriorRisks(latest.executionRisks,decision,originalRequest,latest.rawEvidence)
        && results.length > 0 && results.every(result=>result.status!=='rejected' && !result.isSpeculation && !result.hasWriteConflicts && !result.uncoveredScope.length && !result.uncoveredCriterionIds.length)
        && (latest.rawEvidence.length > 0 || artifactEvidence.length > 0)
        && artifactEvidence.every(item=>item.state==='text' && !item.truncated && !item.omittedEvidenceCount)
        && results.every(result=>!result.artifactRefs.length || artifactEvidence.length > 0);
      const met = !error && (latest.work.watchRule?.requestedOutcome === 'one_time' ? oneTimeMet : watchGoalMet(latest.work,latest.binding,decision,originalRequest,latest.rawEvidence));
      const requestedStop = decision.stopAssessment?.status === "met";
      const followUp = !met && !error ? decision.waitPlan
        ? this.followUp.arrangeWait(latest.work,binding,decision,originalRequest,latest.rawEvidence)
        : this.followUp.enqueue(latest.work,binding,decision,originalRequest,current.teamContinuationTargets) : {scheduled:false};
      this.reconcileNextStepBlockers(work.workId,followUp.scheduled);
      const waitingOnPlan = works.repo.listSubscriptions(work.workId).some(s => !s.stoppedAt && (s.nextWakeAt !== undefined || s.source !== 'cron'));
      if (!met && latest.work.lifecycle === 'active' && latest.work.watchRule?.executionMode === 'continuous' && !followUp.scheduled
        && (decision.decision === 'ask' || !waitingOnPlan)) {
        const reasonCode = decision.decision === 'ask' ? 'user-input' : 'invalid-schedule';
        const blockerId = `watch-next-step:${id}:${reasonCode}`;
        if (!works.repo.listOpenBlockers(work.workId).some(blocker => blocker.reasonCode === reasonCode)) {
          if (works.repo.getBlocker(blockerId)) works.repo.reopenBlocker(blockerId,work.workId);
          else works.repo.insertBlocker({blockerId,workId:work.workId,reportedByBotId:work.ownerBotId,kind:'operational',
            reasonCode,reason:decision.decision === 'ask' ? decision.reply : followUp.notice ?? '持续目标尚未结束，但没有可执行的下一步或真实等待安排。',
            waitingForUserInput:decision.decision === 'ask',status:'open',createdAt:Date.now()});
        }
      }
      const reply = (decision.decision === "continue" || decision.waitPlan) && !followUp.scheduled ? "本次交付已保留的结果，原目标仍有未完成部分。没有安排继续执行，也没有重放已完成或结果未知的动作。" : requestedStop && !met ? `${presentation.summary}\n\n停止条件尚未由本轮有效证据完成核对，未将持续委托标记完成。` : decision.reply;
      const conditionSilent = !error && !requestedStop && decision.stopAssessment?.status !== 'unknown'
        && watchNotificationNotMet(latest.work,latest.binding,decision,originalRequest,[...latest.rawEvidence,...notificationArtifactEvidence])
        && !works.repo.listOpenBlockers(work.workId).length && !works.partialResults.gaps(work.workId).length
        && !works.partialResults.plans(work.workId).some(plan=>!['cancelled','settled'].includes(plan.state))
        && !works.repo.listAdmissions(work.workId).some(admission=>['admitted','attempted','unknown'].includes(admission.state))
        && results.length > 0 && results.every(result=>result.status!=='rejected' && !result.isSpeculation && !result.hasWriteConflicts && !result.uncoveredScope.length && !result.uncoveredCriterionIds.length)
        && artifactEvidence.length > 0 && artifactEvidence.every(item=>item.state==='text' && !item.truncated && !item.omittedEvidenceCount)
        && results.every(result=>!result.artifactRefs.length || artifactEvidence.length > 0);
      const silent = !met && !latest.executionRisks.items.length && (conditionSilent || (!decision.notificationAssessment || decision.notificationAssessment.status === 'not_applicable') && work.watchRule?.executionMode !== 'continuous' && !decision.followUp && !requestedStop && decision.stopAssessment?.status !== 'unknown' && presentation.silent && decision.outcome === 'completed' && decision.decision !== 'ask' && !error);
      if (!silent && !this.options.deliver({bindingId:id,eventId:`watch-supervision:${id}`,text:reply,category:'result',
        notices:[...(latest.executionRisks.items.length ? ['仍有旧执行或工具效果尚未核实：'+latest.executionRisks.items.map(item=>`${item.actionKind}（操作 ${item.operationId}，绑定 ${item.bindingId??'未绑定'}，版本 ${item.intentRevision}，状态 ${item.state}）`).join('；')+(latest.executionRisks.omittedRiskCount ? `；另有 ${latest.executionRisks.omittedRiskCount} 项未在本次消息展开，可在事项记录查询` : '')+'。这些风险保留在事项记录；未重放原动作，停止请求不代表已经停止或成功。'] : []),...(followUp.notice ? [followUp.notice] : []),...(source.teamAssignment?.watchRound?.sequence ? [`团队观察轮次：第 ${source.teamAssignment.watchRound.sequence} 轮（持久调度记录）`] : []),`本轮执行回执时间：${binding.settledAt ? new Date(binding.settledAt).toISOString() : '未记录'}（不是来源内容发布时间）`,...(error ? [`前台整理错误：${error}`] : []), met ? oneTimeMet ? '已核对一次执行目标完成，不再安排下一轮。' : '已依据本轮实际观察核对停止条件，停止新检查并结算在途轮次，无须人工确认。' : work.lifecycle!=='active' ? '持续委托已暂停或正在结束，不会安排新检查。' : followUp.scheduled ? '下一步已持久安排，继续推进原目标。' : works.repo.listSubscriptions(work.workId).some(s => !s.stoppedAt && (s.nextWakeAt !== undefined || s.source !== 'cron')) ? '本轮结束不结束持续委托，后续按已保存计划运行。' : '持续目标尚未结束，但当前没有可运行的后续安排，需要明确下一步或等待条件。']})) throw Error('持续委托结果尚未送达原会话');
      db.prepare('UPDATE work_watch_reviews SET state=?,reviewed_at=?,retry_at=0 WHERE binding_id=?').run(met?'finishing':silent?'silent':'delivered',Date.now(),id);
      if (followUp.scheduled) this.options.wake();
      if (met) {
        works.beginReviewedWatchCompletion(work.workId,id,watchGoalClosureSummary(decision,work));
        this.reconcileNextStepBlockers(work.workId);
        if (!this.hasPending(work.workId) && works.settleReviewedWatchCompletion(work.workId,id,watchGoalClosureSummary(decision,work)))
          db.prepare("UPDATE work_watch_reviews SET state='delivered' WHERE binding_id=?").run(id);
      }
    });
  }
}
