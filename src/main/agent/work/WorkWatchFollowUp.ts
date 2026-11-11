import { createHash } from "node:crypto";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkCompletionOptions } from "./WorkCompletionCoordinator";
import type { WorkResultDecision } from "./BotWorkResultTurn";
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
        ? '本轮已不属于当前计划' : attempts >= 2 ? '本轮已补查两次，保留明确局限并等待正常下一轮，不形成即时重试循环' : undefined;
    return {allowed:!reason,attempts,...reason?{reason}:{}};
  }
  enqueue(work: WorkDto, binding: WorkExecutionBindingDto, decision: WorkResultDecision, originalRequest: unknown): {scheduled:boolean;notice?:string} {
    if (!decision.followUp) return {scheduled:false};
    const availability = this.availability(work,binding);
    if (!availability.allowed) return {scheduled:false,notice:availability.reason};
    const request = originalRequest as {userRequest?:{messages?:{text:string}[]}};
    const text = request.userRequest?.messages?.map(m => m.text).join('\n') || `${work.title}\n${work.goalDescription ?? ''}`;
    if (!text.includes(decision.followUp.requestExcerpt)) return {scheduled:false,notice:'补查未对应原委托中的明确要求，保留原计划。'};
    if (decision.outcome === 'completed') return {scheduled:false,notice:'本轮观察已完整，不另行补查。'};
    // Nested transaction/savepoint: a rejected plan must not leave orphan gaps.
    try {
      return this.options.db.transaction(() => {
        const {works} = this.options;
        const existing = works.partialResults.plans(work.workId).find(p => p.sourceBindingId === binding.bindingId
          && p.gapItemIds.every(id => id.startsWith('watch-followup:')) && p.state !== 'cancelled');
        if (existing) return {scheduled:true,notice:'本轮补查已安排，沿用同一计划，不重复派发。'};
        const itemId = `watch-followup:${createHash('sha256').update(binding.bindingId).digest('hex')}`;
        works.partialResults.record(binding,[{itemId,task:`只读补查：${decision.followUp!.task}。只读取/查询原委托所需信息，不写入、发送或发布，不重做已有动作。`,
          required:true,dependencies:[],criterionIds:[],nativeStatus:'watch_read_followup',outcome:'not_started',artifactRefs:[],writeConflicts:[],
          summary:`本轮待补观察：${decision.followUp!.requestExcerpt}`}]);
        const current = works.getWork(work.workId)!;
        const result = works.continueWork({kind:'bot',botId:current.ownerBotId,userId:current.userId,host:'background',grants:current.authorization},
          {operationId:`watch-followup:${binding.bindingId}`,workId:current.workId,sourceBindingId:binding.bindingId,gapItemIds:[itemId],
            reason:`前台自动补查本轮缺失观察：${decision.followUp!.task}`,
            versionGuard:{expectedStateVersion:current.stateVersion,expectedIntentRevision:current.intentRevision,expectedOwnerEpoch:current.ownerEpoch}});
        if (!result.ok) throw Error(result.message);
        return {scheduled:true,notice:`已自动安排只读补查：${decision.followUp!.task}。完成后继续核对；原持续关注周期不变，无须你操作。`};
      })();
    } catch (error) { return {scheduled:false,notice:`本轮补查未能安排：${String(error)}；原持续关注计划保留。`}; }
  }
  settle(binding: WorkExecutionBindingDto, decision: WorkResultDecision): void {
    if (decision.outcome !== 'completed' || binding.status !== 'completed') return;
    const plan = this.sourcePlan(binding);
    if (!plan || !plan.gapItemIds.every(id => id.startsWith('watch-followup:'))) return;
    const {works} = this.options;
    const items = works.partialResults.list(binding.workId).filter(item => item.bindingId === plan.sourceBindingId && plan.gapItemIds.includes(item.itemId));
    works.partialResults.record(binding,items.map(item => ({itemId:item.itemId,task:item.task,required:true,dependencies:[],criterionIds:[],
      nativeStatus:'watch_read_followup',outcome:'completed',artifactRefs:[],writeConflicts:[],summary:`前台已核对本轮补查结果：${decision.reply}`})));
  }
}
