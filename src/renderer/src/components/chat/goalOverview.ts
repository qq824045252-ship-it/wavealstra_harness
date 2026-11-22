import type { ConversationGoalContinuationDto, ConversationGoalDto, ConversationGoalEvidenceDto } from "@shared/conversation-goal";

export const GOAL_CHECK_REASON: Record<string, string> = {
  waiting_input: "等待用户输入", queued: "等待已排队的输入", busy: "等待当前执行结算",
  compacting: "等待上下文整理", no_session: "没有可调度的会话", igniting: "等待续跑结算",
  active: "进行中", paused: "Goal 已暂停", closing: "Goal 正在关闭", closed: "Goal 已关闭",
  complete_pending: "验收项已满足或豁免，等待结项", watch: "由 Watch 调度",
  deferred: "续跑已暂停", exhausted: "达到续跑上限", disabled: "自动续跑已关闭",
  attempts: "自动续跑次数用尽", budget: "预算用尽", no_progress: "连续无进展",
  user_interrupt: "用户中断", turn_aborted: "本轮中止", run_failed: "执行失败", restart: "宿主重启",
  manual_stop: "手动停止", submitting: "正在提交续跑", submitted: "续跑已受理", submit_failed: "续跑提交失败",
  goal_changed: "检查期间 Goal 已变更", ledger_changed: "检查期间续跑状态已变更",
};

export function goalContinuationSummary(continuation?: ConversationGoalContinuationDto): string | undefined {
  if (!continuation) return undefined;
  if (continuation.state === "igniting") return "自动续跑中";
  if (continuation.state !== "deferred" && continuation.state !== "exhausted") return undefined;
  const reason = continuation.deferReason && GOAL_CHECK_REASON[continuation.deferReason];
  const status = continuation.state === "exhausted" ? "续跑已停止" : "续跑已暂停";
  return reason ? `${status}（${reason}）` : status;
}

const WAITING_CHECKS = new Set(["waiting_input", "queued", "busy", "compacting", "no_session", "complete_pending", "watch"]);

export function goalWaitingSummary(goal: ConversationGoalDto): string | undefined {
  if (goal.closedAt != null || goal.status === "achieved" || goal.status === "cancelled") return undefined;
  const continuation = goal.continuation;
  const stopped = continuation?.state === "deferred" || continuation?.state === "exhausted"
    ? goalContinuationSummary(continuation) : undefined;
  const check = continuation?.lastCheck;
  const currentCheck = goal.status === "active" && !stopped && check && WAITING_CHECKS.has(check.reason)
    ? GOAL_CHECK_REASON[check.reason] : undefined;
  return [goal.waitingReason, stopped ?? currentCheck].filter(Boolean).join(" · ") || undefined;
}

/** Overview counters describe recorded activity. They do not infer task completion. */
export function goalProgressFacts(details?: ConversationGoalEvidenceDto): string {
  if (!details) return "";
  const facts: string[] = [];
  const files = details.savedArtifacts ?? [];
  const latest = files[0];
  const reviewed = files.filter(file => file.verification?.kind === "user").length;
  if (latest) {
    const count = files.length === 1 ? "已登记 1 个文件版本" : `已登记 ${files.length} 个文件版本`;
    facts.push(`${count}，已核验 ${reviewed} 个；最新 ${latest.request.name}（${latest.verification ? "已核验" : "待核验"}）`);
  }
  const deliveries = details.deliverables.filter(item => item.status === "accepted" || item.status === "proposed").length;
  const returned = new Set((details.activity?.runs ?? []).filter(run => run.child && run.returned)
    .map(run => JSON.stringify([run.taskId, run.child?.id]))).size;
  if (deliveries) facts.push(`${deliveries} 项交付已返回`);
  if (returned) facts.push(`${returned} 个子代理已返回`);
  const verifiedCriteria = details.verification.filter(item => item.evidence.length > 0).length;
  if (verifiedCriteria) facts.push(`${verifiedCriteria} 项验收有核验证据`);
  const checks = (details.activity?.nativeEvidence ?? []).filter(record => record.kind === "check" && record.passed).length;
  if (!facts.length && checks) facts.push(`${checks} 次检查通过`);
  const completed = (details.activity?.runs ?? []).filter(run => !run.child && run.status === "completed").length;
  if (!facts.length && completed) facts.push(`${completed} 次主代理执行已完成`);
  return facts.join(" · ");
}
