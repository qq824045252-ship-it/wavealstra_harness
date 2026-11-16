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

/** Exact host evidence takes precedence over navigation associations. A source
 * Bot's collaboration return keeps its own prose, with the returned Work's phase. */
export function botTaskReplyMessageFeedback(message: BotMessageDto): WorkFeedbackDto | undefined {
  return message.role === "assistant" ? message.workFeedback ?? message.collaborationResult : undefined;
}

/** Only one unambiguous host-linked task owns ordinary prose. A reply discussing
 * several Works stays shared rather than copying its contents into every task. */
export function botTaskReplyMessageWorkId(message: BotMessageDto): string | undefined {
  if (message.role !== "assistant") return undefined;
  const feedback = botTaskReplyMessageFeedback(message);
  if (feedback) return feedback.workId;
  const workIds = [...new Set(message.workIds)];
  return workIds.length === 1 ? workIds[0] : undefined;
}

/** Recover exact source/return ownership from immutable host provenance when a
 * partial history page has not yet acquired the source reply's Work links.
 * Scope and request checks are required even though message IDs are normally
 * globally unique. No association can originate from user-supplied metadata. */
export function botTaskReplyAssociations(messages: readonly BotMessageDto[]): {
  owned: Map<BotMessageDto, string>; sourceReplies: Map<BotMessageDto, BotMessageDto>;
} {
  const owned = new Map<BotMessageDto, string>();
  const sourceReplies = new Map<BotMessageDto, BotMessageDto>();
  const key = (message: BotMessageDto, messageId = message.messageId) => JSON.stringify([
    message.botId, message.teamId ?? null, message.conversationId, messageId,
  ]);
  const byId = new Map<string, BotMessageDto>();
  const resolved = new Map<BotMessageDto, string | undefined>();
  for (const message of messages) {
    byId.set(key(message), message);
    if (message.role === "user") {
      const workIds = [...new Set(message.workIds)];
      resolved.set(message, workIds.length === 1 ? workIds[0] : undefined);
      continue;
    }
    const workId = botTaskReplyMessageWorkId(message);
    if (workId) { owned.set(message, workId); resolved.set(message, workId); }
    else if (message.workIds.length) resolved.set(message, undefined);
  }
  const sourceCandidates = new Map<BotMessageDto, Set<string>>();
  for (const message of messages) {
    const origin = message.role === "assistant" ? message.peerOrigin : undefined;
    if (origin?.kind !== "return" || origin.sourceBotId !== message.botId
      || origin.sourceConversationId !== message.conversationId) continue;
    const source = byId.get(key(message, origin.sourceAssistantMessageId));
    if (!source || source.role !== "assistant" || source === message || source.requestId !== origin.sourceRequestId) continue;
    sourceReplies.set(message, source);
    const workId = owned.get(message);
    if (!workId || source.workIds.length || source.referenceMessageId || botTaskReplyMessageFeedback(source)) continue;
    let candidates = sourceCandidates.get(source);
    if (!candidates) sourceCandidates.set(source, candidates = new Set());
    candidates.add(workId);
  }
  for (const [source, candidates] of sourceCandidates) if (candidates.size === 1) {
    const workId = [...candidates][0];
    owned.set(source, workId); resolved.set(source, workId);
  }
  const continuations = new Map<BotMessageDto, BotMessageDto>();
  for (const message of messages) {
    if (message.role !== "assistant" || resolved.has(message)) continue;
    const source = message.referenceMessageId ? byId.get(key(message, message.referenceMessageId)) : sourceReplies.get(message);
    if (source && source !== message) continuations.set(message, source);
  }
  // Memoize each traversed chain once. Missing targets, ambiguous references and
  // cycles stay unowned; deep reply chains do not recurse or rescan the history.
  for (const message of messages) {
    if (message.role !== "assistant" || resolved.has(message)) continue;
    const path: BotMessageDto[] = [];
    const visiting = new Set<BotMessageDto>();
    let source: BotMessageDto | undefined = message;
    while (source && !resolved.has(source) && !visiting.has(source)) {
      path.push(source); visiting.add(source); source = continuations.get(source);
    }
    const workId = source ? resolved.get(source) : undefined;
    for (const item of path) {
      resolved.set(item, workId);
      if (workId) owned.set(item, workId);
    }
  }
  return { owned, sourceReplies };
}

/** The phase is a host-authored fact, never a guess from the reply's wording.
 * A worker result still needs review; a verified partial milestone is execution
 * progress. Keep previous versions in their original phase for later reading.
 */
export function botTaskReplyMessageStage(feedback?: WorkFeedbackDto, work?: WorkProjectionDto): BotTaskReplyStageId {
  if (!feedback) return "execution";
  if (feedback.report?.milestone) return "execution";
  if (feedback.kind === "closure" || feedback.report?.completion?.nextStep === "deliver") return "result";
  // A host-confirmed successful closure can finalize the exact accepted result
  // even when that immutable worker report predates the completion decision.
  // Never promote partial, rejected, stale, unbound, or still-needs-input data.
  if (work?.lifecycle === "closed" && work.closureConclusion === "succeeded"
    && feedback.kind === "result" && feedback.report?.current && feedback.report.reviewStatus === "accepted"
    && !feedback.report.completion && feedback.executionId
    && feedback.intentRevision === work.intentRevision && feedback.inputSnapshotId === work.inputSnapshotId
    && botTaskReplyFeedbackCurrent(feedback, work)) return "result";
  if (feedback.kind === "result" || feedback.report?.completion) return "review";
  return "execution";
}

/** Only a successful source-Bot answer can replace its exact public fallback.
 * Keep both durable messages; this is a view fold, not deletion or a text-based
 * guess. Distinct versions, files, scopes and incomplete replies never collide. */
export function botTaskReplyVisibleMessages(messages: readonly BotMessageDto[]): BotMessageDto[] {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  const key = (message: BotMessageDto, feedback: WorkFeedbackDto) => JSON.stringify([
    message.botId, message.teamId ?? null, message.conversationId, canonical(feedback),
  ]);
  const returned = new Set<string>();
  for (const message of messages) {
    const origin = message.peerOrigin;
    if (message.role !== "assistant" || message.status !== "completed" || message.error
      || origin?.kind !== "return" || origin.sourceBotId !== message.botId || origin.sourceConversationId !== message.conversationId
      || !message.collaborationResult?.report || !(message.text.trim()
        || message.segments?.some(segment => segment.kind !== "receipt" && segment.text.trim()))) continue;
    returned.add(key(message, message.collaborationResult));
  }
  return messages.filter(message => !message.workFeedback?.report
    || !message.requestId.startsWith("delegated-feedback:")
    || !returned.has(key(message, message.workFeedback)));
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
  taskMessages: readonly BotMessageDto[] = [], messageWorkIds?: ReadonlyMap<BotMessageDto, string>): BotTaskReplyPresentation {
  const work = suppliedWork?.workId === workId ? suppliedWork : undefined;
  // The timeline's view-only map retains exact reference ownership when the
  // referenced user question lives outside this task's assistant-message list.
  const owned = messageWorkIds ?? botTaskReplyAssociations(taskMessages).owned;
  const messages = taskMessages.filter(message => message.role === "assistant"
    && (botTaskReplyMessageWorkId(message) ?? owned.get(message)) === workId);
  // Ordinary task replies are content, not lifecycle observations. Retain their
  // identity and all segments without treating a completed chat turn as success.
  const observations = messages.flatMap(message => {
    const feedback = botTaskReplyMessageFeedback(message);
    return feedback && botTaskReplyFeedbackCurrent(feedback, work) ? [{ message, feedback }] : [];
  });
  const lastObservation = observations.at(-1);
  const currentMessages = observations.filter(item => item.message.status === "completed" && !item.message.error);
  const latest = currentMessages.at(-1)?.feedback;
  const reportMessage = [...currentMessages].reverse().find(item => item.feedback.report
    && !item.feedback.report.milestone);
  // Without a Work snapshot, newer attempts must not borrow an older attempt's
  // deliver/ask decision. A late receipt for the exact same execution can retain
  // its reviewed result; missing identity is insufficient to make that claim.
  const supersededReport = !work && reportMessage && observations.slice(observations.indexOf(reportMessage) + 1).some(item => {
    const previous = reportMessage.feedback;
    const next = item.feedback;
    if (next.kind === "closure") return false;
    return previous.intentRevision !== undefined && next.intentRevision !== undefined && previous.intentRevision !== next.intentRevision
      || previous.inputSnapshotId !== undefined && next.inputSnapshotId !== undefined && previous.inputSnapshotId !== next.inputSnapshotId
      || !previous.executionId || !next.executionId || previous.executionId !== next.executionId;
  });
  const currentReport = supersededReport ? undefined : reportMessage?.feedback.report;
  const unsettledFeedback = !work && lastObservation && (lastObservation.message.status !== "completed" || lastObservation.message.error)
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
    : !unsettledFeedback && lastObservation?.feedback.kind === "closure";
  const succeeded = work?.lifecycle === "closed" && work.closureConclusion === "succeeded" && !expired;
  const needsInput = blockers.some(blocker => blocker.waitingForUserInput) || !work && !unsettledFeedback
    && (completion?.nextStep === "ask" || latest?.kind === "blocker" && latest.category === "decision");
  const feedbackInterrupted = Boolean(unsettledFeedback && (unsettledFeedback.message.error
    || ["failed", "unknown", "cancelled"].includes(unsettledFeedback.message.status)));
  const attention = summary ? summary.status.group === "attention" : blockers.length > 0 || !busy && (interrupted || gaps) || needsInput || feedbackInterrupted;
  const paused = work?.lifecycle === "paused";

  let currentStageId: BotTaskReplyStageId = !work && lastObservation ? botTaskReplyMessageStage(lastObservation.feedback) : "execution";
  if (terminal) currentStageId = "result";
  else if (work?.lifecycle === "closing") currentStageId = "review";
  else if (summary) currentStageId = summary.status.group === "results" ? "review" : "execution";
  else if (unsettledFeedback) currentStageId = botTaskReplyMessageStage(unsettledFeedback.feedback);
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
  else if (unsettledFeedback) statusLabel = unsettledFeedback.message.error ? "进展回报失败" : {
    queued: "等待进展回报", running: "正在更新进展", failed: "进展回报失败", unknown: "进展回报待核对", cancelled: "进展回报已停止", completed: "进展已更新",
  }[unsettledFeedback.message.status];
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
  for (const message of botTaskReplyVisibleMessages(messages))
    stages.find(stage => stage.id === botTaskReplyMessageStage(botTaskReplyMessageFeedback(message), work))!.messages.push(message);
  return { title: work?.title || [...messages].reverse().map(botTaskReplyMessageFeedback).find(feedback => feedback?.report?.title)?.report?.title || "任务进度",
    statusLabel, currentStageId, stages };
}
