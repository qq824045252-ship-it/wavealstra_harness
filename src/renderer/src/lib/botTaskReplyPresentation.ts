import type { BotMessageDto, WorkFeedbackDto } from "@shared/bot-conversation";
import type { WorkProjectionDto } from "@shared/bot-work";

export type BotTaskReplyStageId = "request" | "execution" | "review" | "result";
export type BotTaskReplyStageState = "pending" | "current" | "completed" | "attention" | "paused" | "ended";
export interface BotTaskReplyStage {
  id: BotTaskReplyStageId;
  label: string;
  state: BotTaskReplyStageState;
  description: string;
  messages: BotMessageDto[];
}
export interface BotTaskReplyPresentation {
  title: string;
  statusLabel: string;
  currentStageId: BotTaskReplyStageId;
  stages: BotTaskReplyStage[];
}

/** The phase is a host-authored fact, never a guess from the reply's wording.
 * A worker result still needs review; a verified partial milestone is execution
 * progress. Keep previous versions in their original phase for later reading.
 */
export function botTaskReplyMessageStage(feedback: WorkFeedbackDto): BotTaskReplyStageId {
  if (feedback.report?.milestone) return "execution";
  if (feedback.kind === "closure" || feedback.report?.completion?.nextStep === "deliver") return "result";
  if (feedback.kind === "result" || feedback.report?.completion) return "review";
  return "execution";
}

export function botTaskReplyFeedbackCurrent(feedback: WorkFeedbackDto, work?: WorkProjectionDto | null): boolean {
  if (feedback.report?.current === false) return false;
  return !work || (feedback.workId === work.workId
    && (feedback.intentRevision === undefined || feedback.intentRevision === work.intentRevision)
    && (feedback.inputSnapshotId === undefined || feedback.inputSnapshotId === work.inputSnapshotId)
    && currentExecution(feedback.executionId, work));
}

function currentExecution(executionId: string | undefined, work: WorkProjectionDto): boolean {
  if (!executionId || work.listSummary) return true;
  const binding = work.executions.find(item => item.bindingId === executionId);
  // An omitted binding is not proof of invalidation. An explicit invalidation
  // is authoritative even if an immutable delivered report still says current.
  return !binding || (binding.invalidatedAt === undefined && binding.status !== "invalidated"
    && binding.intentRevision === work.intentRevision && binding.inputSnapshotId === work.inputSnapshotId);
}

/** Display-only lifecycle phases. They are not a generated plan, percentages,
 * tool calls, acceptance decisions, or an additional execution state machine.
 * Summary projections deliberately omit detail arrays; an empty one cannot be
 * used as evidence that a task has never run or finished.
 */
export function botTaskReplyPresentation(workId: string, suppliedWork?: WorkProjectionDto | null,
  feedbackMessages: readonly BotMessageDto[] = []): BotTaskReplyPresentation {
  const work = suppliedWork?.workId === workId ? suppliedWork : undefined;
  const messages = feedbackMessages.filter(message => message.role === "assistant" && message.workFeedback?.workId === workId);
  const observations = messages.filter(message => botTaskReplyFeedbackCurrent(message.workFeedback!, work));
  const lastObservation = observations.at(-1);
  const currentMessages = observations.filter(message => message.status === "completed" && !message.error);
  const latest = currentMessages.at(-1)?.workFeedback;
  const reportMessage = [...currentMessages].reverse().find(message => message.workFeedback?.report
    && !message.workFeedback.report.milestone);
  // Without a Work snapshot, newer attempts must not borrow an older attempt's
  // deliver/ask decision. A late receipt for the exact same execution can retain
  // its reviewed result; missing identity is insufficient to make that claim.
  const supersededReport = !work && reportMessage && observations.slice(observations.indexOf(reportMessage) + 1).some(message => {
    const previous = reportMessage.workFeedback!;
    const next = message.workFeedback!;
    if (next.kind === "closure") return false;
    return previous.intentRevision !== undefined && next.intentRevision !== undefined && previous.intentRevision !== next.intentRevision
      || previous.inputSnapshotId !== undefined && next.inputSnapshotId !== undefined && previous.inputSnapshotId !== next.inputSnapshotId
      || !previous.executionId || !next.executionId || previous.executionId !== next.executionId;
  });
  const currentReport = supersededReport ? undefined : reportMessage?.workFeedback?.report;
  const unsettledFeedback = !work && lastObservation && (lastObservation.status !== "completed" || lastObservation.error)
    ? lastObservation : undefined;
  const publication = work?.publishedReport;
  const published = work?.inputSnapshotBound && publication?.intentRevision === work.intentRevision
    && publication.inputSnapshotId === work.inputSnapshotId && publication.report.current
    && currentExecution(publication.executionId, work) ? publication.report : undefined;
  const completion = published?.completion ?? (unsettledFeedback ? undefined : currentReport?.completion);
  const summary = work?.listSummary;
  const bindings = work && !summary ? work.executions.filter(binding => binding.intentRevision === work.intentRevision
    && binding.inputSnapshotId === work.inputSnapshotId && !binding.invalidatedAt && binding.status !== "invalidated") : [];
  const currentBindingIds = new Set(bindings.map(binding => binding.bindingId));
  const runtime = work && !summary ? (work.runtimeObservations ?? []).filter(item => currentBindingIds.has(item.bindingId)) : [];
  const busy = bindings.some(binding => ["pending", "submitted", "running"].includes(binding.status))
    || runtime.some(item => ["running", "recovering", "waiting"].includes(item.state));
  const executionComplete = summary ? summary.status.group === "results" || summary.status.group === "succeeded"
    : bindings.length > 0 && bindings.every(binding => binding.status === "completed") && !busy && !work?.phase3?.settlingActions;
  const blockers = work && !summary ? work.blockers.filter(blocker => blocker.status === "open"
    && blocker.kind !== "external_effect" && !blocker.unknownExternalEffectRef) : [];
  const interrupted = bindings.some(binding => ["failed", "stopped", "unknown"].includes(binding.status))
    || runtime.some(item => item.state === "interrupted");
  const gaps = Boolean(work && !summary && (work.phase3?.gaps.some(item => item.required)
    || work.criteria.some(item => item.status === "failed" || item.status === "blocked")));
  const expired = work?.mode === "watch" && work.lifecycle === "closed"
    && work.watchPlan?.termination?.reason === "schedule_expired" && work.watchPlan.termination.settledAt !== undefined;
  const terminal = work ? work.lifecycle === "closed" || Boolean(work.archive?.archivedAt)
    : !unsettledFeedback && lastObservation?.workFeedback?.kind === "closure";
  const succeeded = work?.lifecycle === "closed" && work.closureConclusion === "succeeded" && !expired;
  const needsInput = blockers.some(blocker => blocker.waitingForUserInput) || !work && !unsettledFeedback
    && (completion?.nextStep === "ask" || latest?.kind === "blocker" && latest.category === "decision");
  const feedbackInterrupted = Boolean(unsettledFeedback && (unsettledFeedback.error
    || ["failed", "unknown", "cancelled"].includes(unsettledFeedback.status)));
  const attention = summary ? summary.status.group === "attention" : blockers.length > 0 || !busy && (interrupted || gaps) || needsInput || feedbackInterrupted;
  const paused = work?.lifecycle === "paused";

  let currentStageId: BotTaskReplyStageId = !work && lastObservation ? botTaskReplyMessageStage(lastObservation.workFeedback!) : "execution";
  if (terminal) currentStageId = "result";
  else if (work?.lifecycle === "closing") currentStageId = "review";
  else if (summary) currentStageId = summary.status.group === "results" ? "review" : "execution";
  else if (unsettledFeedback) currentStageId = botTaskReplyMessageStage(unsettledFeedback.workFeedback!);
  else if (busy || work?.mode === "watch" || interrupted) currentStageId = "execution";
  else if (executionComplete) currentStageId = "review";
  else if (completion?.nextStep === "continue") currentStageId = "execution";
  else if (completion?.nextStep === "ask") currentStageId = "review";
  else if (completion?.nextStep === "deliver") currentStageId = "result";
  else if (currentReport) currentStageId = "review";

  let statusLabel: string;
  if (summary) statusLabel = summary.status.label;
  else if (expired) statusLabel = "到期结束";
  else if (work?.lifecycle === "closed") statusLabel = succeeded ? "已完成" : work.closureConclusion === "cancelled"
    ? "已取消" : work.closureConclusion === "ended_unsuccessfully" ? "已结束 · 未完成" : "已结束";
  else if (work?.archive?.archivedAt) statusLabel = "已归档 · 未完成";
  else if (paused) statusLabel = "已暂停";
  else if (work?.lifecycle === "closing") statusLabel = "正在收尾";
  else if (needsInput) statusLabel = "等待补充信息";
  else if (blockers.length) statusLabel = "执行受阻";
  else if (runtime.some(item => item.state === "recovering")) statusLabel = "恢复中";
  else if (bindings.some(binding => ["running", "submitted"].includes(binding.status)) || runtime.some(item => item.state === "running")) statusLabel = "正在执行";
  else if (bindings.some(binding => binding.status === "pending") || runtime.some(item => item.state === "waiting")) statusLabel = "等待执行";
  else if (interrupted) statusLabel = "执行遇到问题";
  else if (gaps) statusLabel = "尚有内容待补齐";
  else if (work?.mode === "watch") statusLabel = "持续跟踪中";
  else if (terminal) statusLabel = "已结束";
  else if (unsettledFeedback) statusLabel = unsettledFeedback.error ? "进展回报失败" : {
    queued: "等待进展回报", running: "正在更新进展", failed: "进展回报失败", unknown: "进展回报待核对", cancelled: "进展回报已停止", completed: "进展已更新",
  }[unsettledFeedback.status];
  else if (executionComplete) statusLabel = "正在核对结果";
  else if (completion?.nextStep === "continue") statusLabel = "继续处理中";
  else if (completion?.nextStep === "deliver") statusLabel = completion.outcome === "completed" ? "结果已核对"
    : completion.outcome === "partial" ? "部分完成" : "结果待核实";
  else if (currentReport) statusLabel = "正在核对结果";
  else if (latest?.report?.milestone) statusLabel = "已有阶段成果";
  else if (!work && latest?.kind === "binding") statusLabel = "执行进展已更新";
  else statusLabel = work ? "等待执行进展" : "等待任务进展";

  const stages: BotTaskReplyStage[] = [
    { id: "request", label: "任务", state: "completed", description: work?.goalDescription?.trim() || "任务已关联到本条回复。", messages: [] },
    { id: "execution", label: "执行", state: executionComplete || succeeded ? "completed" : "pending",
      description: "执行进展、阶段成果和遇到的问题会保留在这里。", messages: [] },
    { id: "review", label: "核对", state: succeeded || currentStageId === "result" && completion?.nextStep === "deliver" ? "completed" : "pending",
      description: "核对执行结果与任务要求，保留补充和修正记录。", messages: [] },
    { id: "result", label: "结果", state: succeeded ? "completed" : "pending",
      description: work?.closureSummary?.trim() || published?.summary || "汇总结果和交付文件会保留在这里。", messages: [] },
  ];
  const active = stages.find(stage => stage.id === currentStageId)!;
  active.state = succeeded ? "completed" : terminal ? "ended" : paused ? "paused" : attention ? "attention" : "current";
  if (!terminal) active.description = `${statusLabel}。${active.description}`;
  for (const message of messages) stages.find(stage => stage.id === botTaskReplyMessageStage(message.workFeedback!))!.messages.push(message);
  return { title: work?.title || [...messages].reverse().find(message => message.workFeedback?.report?.title)?.workFeedback?.report?.title || "任务进度",
    statusLabel, currentStageId, stages };
}
