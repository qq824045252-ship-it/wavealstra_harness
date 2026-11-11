import { continuationProgress, lastContinuationProgress, recordContinuationProgress } from "./WorkContinuationProgress";
import { createHash } from "node:crypto";
import type { WorkDto, WorkExecutionBindingDto, WorkActor } from "../../../shared/bot-work";
import type { WorkCompletionOptions } from "./WorkCompletionCoordinator";
import type { WorkResultDecision } from "./BotWorkResultTurn";
import type { WatchGoalEvidence } from "./WorkWatchGoal";
import { watchTimeExpired } from "../../../shared/work-watch-expiry";

/** Supplemental observations belong to an observation chain, not a new standing
 * commission. Reuse the durable continuation outbox and leave the cron untouched. */
export class WorkWatchFollowUp {
  constructor(private readonly options: WorkCompletionOptions) {}
  private sourcePlan(binding: WorkExecutionBindingDto) {
    const request = this.options.db.prepare("SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?")
      .get(binding.taskId) as {continuation_plan_id:string|null}|undefined;
    return this.options.works.partialResults.plans(binding.workId).find(p => p.planId === request?.continuation_plan_id);
  }
  availability(work: WorkDto, binding: WorkExecutionBindingDto): {allowed:boolean;attempts:number;reason?:string} {
    const {works} = this.options;
    let attempts = 0, current = binding;
    const seen = new Set<string>();
    while (!seen.has(current.bindingId)) {
      seen.add(current.bindingId);
      const plan = this.sourcePlan(current);
      if (!plan) break;
      if (plan.gapItemIds.every(id => id.startsWith('watch-followup:'))) attempts++;
      const source = works.repo.getBinding(plan.sourceBindingId); if (!source) break;
      current = source;
    }
    const reason = work.mode !== 'watch' || work.lifecycle !== 'active' || watchTimeExpired(work,Date.now())
      ? '持续委托已暂停、结束或到期' : binding.status === 'stopped' ? '本轮被停止，不自动重启'
      : binding.invalidatedAt || !works.collaboration.isDelegationAdopted(binding,work) || !works.scheduledBindingCurrent(binding)
        ? '本轮已不属于当前计划' : work.watchRule?.executionMode !== 'continuous' && attempts >= 2 ? '本轮已补查两次，保留明确局限并等待正常下一轮，不形成即时重试循环' : undefined;
    return {allowed:!reason,attempts,...reason?{reason}:{}};
  }
  enqueue(work: WorkDto, binding: WorkExecutionBindingDto, decision: WorkResultDecision, originalRequest: unknown, teamTargets?: unknown): {scheduled:boolean;notice?:string} {
    const continuous = work.watchRule?.executionMode === 'continuous';
    const actionableMissing = continuous && decision.decision === 'continue';
    const readOnly = !actionableMissing || decision.missing[0]?.readOnly === true;
    const next = actionableMissing ? decision.missing[0] : decision.followUp;
    if (!next) return {scheduled:false};
    const availability = this.availability(work,binding);
    if (!availability.allowed) return {scheduled:false,notice:availability.reason};
    const request = originalRequest as {userRequest?:{messages?:{text:string}[]}};
    const text = request.userRequest?.messages?.map(m => m.text).join('\n') || `${work.title}\n${work.goalDescription ?? ''}`;
    if (!text.includes(next.requestExcerpt)) return {scheduled:false,notice:'补查未对应原委托中的明确要求，保留原计划。'};
    if (!continuous && decision.outcome === 'completed') return {scheduled:false,notice:'本轮观察已完整，不另行补查。'};
    if (continuous) {
      const lineage=new Set(this.options.works.partialResults.recovery.ancestry(binding).map(item=>item.bindingId));
      const unknown=this.options.works.repo.listAdmissions(work.workId).some(item=>item.state==='unknown' && !!item.bindingId && lineage.has(item.bindingId));
      if (unknown && actionableMissing && decision.missing.some(item=>item.readOnly!==true)) return {scheduled:false,notice:'原执行链有未核实的外部效果，不重放写入；只可安排明确独立的只读补查。'};
    }
    const progress = continuous ? continuationProgress(this.options.works,work) : undefined;
    const previousProgress = continuous ? lastContinuationProgress(this.options.db,work) : undefined;
    if (previousProgress && previousProgress.bindingId !== binding.bindingId && previousProgress.fingerprint === progress)
      return {scheduled:false,notice:'上一轮后没有新增已核验成果，不重复执行同一缺项；保留实际缺口。'};
    if (actionableMissing && this.options.works.teams.get(work.workId)) {
      if (decision.missing.some(item => !text.includes(item.requestExcerpt))) return {scheduled:false,notice:'后续步骤必须对应原始委托。'};
      const scheduled = this.options.works.teams.continueMissing(binding,decision.missing,teamTargets,decision.reply);
      if (scheduled) recordContinuationProgress(this.options.db,binding,work,progress!,Date.now());
      return {scheduled,notice:scheduled ? '已按原成员分工安排下一步推进，负责人收到结果后继续核对。' : '团队后续步骤未能派发，需要核对当前成员与缺项证据。'};
    }
    // Nested transaction/savepoint: a rejected plan must not leave orphan gaps.
    try {
      return this.options.db.transaction(() => {
        const {works} = this.options;
        const existing = works.partialResults.plans(work.workId).find(p => p.sourceBindingId === binding.bindingId
          && p.gapItemIds.every(id => id.startsWith('watch-followup:')) && p.state !== 'cancelled');
        if (existing) return {scheduled:true,notice:'本轮补查已安排，沿用同一计划，不重复派发。'};
        const itemId = `watch-followup:${createHash('sha256').update(binding.bindingId).digest('hex')}`;
        works.partialResults.record(binding,[{itemId,task: !readOnly ? `继续原授权目标：${next.task}。保留已有成果，不重复已完成动作。` : `只读补查：${next.task}。只读取/查询原委托所需信息，不写入、发送或发布，不重做已有动作。`,
          required:true,dependencies:[],criterionIds:[],nativeStatus:readOnly ? 'watch_read_followup' : 'watch_continuation',outcome:'not_started',artifactRefs:[],writeConflicts:[],
          summary:`本轮待补观察：${next.requestExcerpt}`}]);
        const current = works.getWork(work.workId)!;
        const result = works.continueWork({kind:'bot',botId:current.ownerBotId,userId:current.userId,host:'background',grants:current.authorization},
          {operationId:`watch-followup:${binding.bindingId}`,workId:current.workId,sourceBindingId:binding.bindingId,gapItemIds:[itemId],
            reason:`前台自动补查本轮缺失观察：${next.task}`,
            versionGuard:{expectedStateVersion:current.stateVersion,expectedIntentRevision:current.intentRevision,expectedOwnerEpoch:current.ownerEpoch}});
        if (!result.ok) throw Error(result.message);
        if (continuous) recordContinuationProgress(this.options.db,binding,work,progress!,Date.now());
        return {scheduled:true,notice:continuous ? `已安排下一步推进：${next.task}。完成后继续核对。` : `已自动安排只读补查：${next.task}。完成后继续核对；原持续关注周期不变，无须你操作。`};
      })();
    } catch (error) { return {scheduled:false,notice:`本轮补查未能安排：${String(error)}；原持续关注计划保留。`}; }
  }
  arrangeWait(work: WorkDto, binding: WorkExecutionBindingDto, decision: WorkResultDecision,
    originalRequest: unknown, evidence: WatchGoalEvidence[]): {scheduled:boolean;notice?:string} {
    const plan = decision.waitPlan;
    if (!plan) return {scheduled:false};
    if (work.watchRule?.executionMode !== 'continuous' || !this.availability(work,binding).allowed
      || decision.decision === 'ask' || decision.missing.length || decision.followUp)
      return {scheduled:false,notice:'只有当前持续目标确实需要等待且没有可执行缺项时才保存等待计划。'};
    const request=originalRequest as {userRequest?:{messages?:{text:string}[]}};
    const userText=request.userRequest?.messages?.map(item=>item.text).join('\n') ?? '';
    if (!plan.requestExcerpt.trim() || !userText.includes(plan.requestExcerpt)) return {scheduled:false,notice:'等待安排没有对应原始委托。'};
    if (plan.basis === 'observed_dependency' && (!plan.evidence || !evidence.some(item=>item.resultId===plan.evidence!.resultId && item.text.includes(plan.evidence!.quote))))
      return {scheduled:false,notice:'等待依赖缺少本轮真实来源证据。'};
    if (plan.nextWakeAt !== undefined && (!Number.isSafeInteger(plan.nextWakeAt) || plan.nextWakeAt <= Date.now() || plan.nextWakeAt > 8640000000000000))
      return {scheduled:false,notice:'等待时间必须是有效的未来时刻。'};
    if ((plan.nextWakeAt !== undefined) === Boolean(plan.eventSource)) return {scheduled:false,notice:'等待必须明确选择一次时刻或一个事件来源。'};
    const {works}=this.options;
    const lineage=new Set(works.partialResults.recovery.ancestry(binding).map(item=>item.bindingId));
    if (works.repo.listAdmissions(work.workId).some(item=>item.state==='unknown' && !!item.bindingId && lineage.has(item.bindingId)))
      return {scheduled:false,notice:'原执行链有未核实的外部效果，不能借等待计划重放写入；先安排独立的只读补查。'};
    if (plan.eventSource && (!works.ingress.availableEventSources().some(item=>item.source===plan.eventSource) || works.teams.get(work.workId)))
      return {scheduled:false,notice:'此事件来源未接入或团队不支持事件等待；没有创建虚假监听。'};
    if (plan.eventSource === 'file') {
      // This synchronous review must not invent a fresh baseline from old evidence.
      // Keep an already armed file subscription; a new target uses the frontend's real read.
      if (work.watchRule?.eventSource === 'file' && work.watchRule.eventTarget === plan.eventTarget
        && work.goalSources.length === 1 && work.goalSources[0].sourceType === 'file'
        && work.goalSources[0].sourceRef === plan.eventTarget && work.goalSources[0].inputSnapshotId.startsWith('sha256:')
        && works.repo.listSubscriptions(work.workId).some(item=>!item.stoppedAt && item.source==='file' && item.sourceTarget===plan.eventTarget))
        return {scheduled:true,notice:'沿用已绑定真实基线的文件事件等待，不重建订阅或重放旧来源。'};
      return {scheduled:false,notice:'文件事件需要先通过 work_amend 绑定真实文件内容基线；没有创建虚假监听。'};
    }
    const operationId=`watch-wait:${binding.bindingId}`;
    if (works.repo.getReceipt(work.userId,operationId)) return {scheduled:true,notice:'沿用已保存的等待计划，不重复安排。'};
    try {
      return works.transaction(()=>{
        const actor:WorkActor={kind:'bot',botId:work.ownerBotId,userId:work.userId,host:'background',grants:work.authorization};
        // A fresh subscription establishes the next-event baseline; old routes and receipts remain history.
        for (const subscription of works.repo.listSubscriptions(work.workId).filter(item=>!item.stoppedAt)) {
          const stopped=works.stopSubscription(actor,work.workId,subscription.subscriptionId);if(!stopped.ok)throw Error(stopped.message);
        }
        const current=works.getWork(work.workId)!;
        const changed=works.amendWork(actor,{operationId,workId:work.workId,
          watchRule:{...current.watchRule,executionMode:'continuous',subscriptions:[plan.eventSource ?? 'cron'],
            cronExpression:undefined,nextWakeAt:plan.nextWakeAt,eventSource:plan.eventSource,eventTarget:plan.eventTarget,eventFilter:undefined,
            triggerMode:plan.eventSource ? 'next_event' : undefined,
            scheduleBasis:plan.basis==='user_specified'?'user_specified':'recommended',scheduleRationale:plan.reason},
          versionGuard:{expectedStateVersion:current.stateVersion,expectedIntentRevision:current.intentRevision,expectedOwnerEpoch:current.ownerEpoch}});
        if(!changed.ok)throw Error(changed.message);
        return {scheduled:true,notice:plan.eventSource ? `已保存等待下一次 ${plan.eventSource} 事件的安排：${plan.reason}` : `已保存一次后续执行时间 ${new Date(plan.nextWakeAt!).toISOString()}：${plan.reason}`};
      });
    } catch(error) {return {scheduled:false,notice:`等待安排未保存：${String(error)}`};}
  }
  settle(binding: WorkExecutionBindingDto, decision: WorkResultDecision): void {
    if (decision.outcome !== 'completed' || binding.status !== 'completed') return;
    const plan = this.sourcePlan(binding);
    if (!plan || !plan.gapItemIds.every(id => id.startsWith('watch-followup:'))) return;
    const {works} = this.options;
    const items = works.partialResults.list(binding.workId).filter(item => item.bindingId === plan.sourceBindingId && plan.gapItemIds.includes(item.itemId));
    works.partialResults.record(binding,items.map(item => ({itemId:item.itemId,task:item.task,required:true,dependencies:[],criterionIds:[],
      nativeStatus:item.nativeStatus,outcome:'completed',artifactRefs:[],writeConflicts:[],summary:`前台已核对本轮补查结果：${decision.reply}`})));
  }
}
