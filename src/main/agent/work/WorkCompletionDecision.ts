import { createHash } from "node:crypto";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkResultDecision } from "./WorkResultDecision";
import type { CompletionTurn, WorkCompletionOptions } from "./WorkCompletionCoordinator";
import { continuationProgress, lastContinuationProgress, recordContinuationProgress } from "./WorkContinuationProgress";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A host override must replace the proposal, not guess at promises in arbitrary languages. */
const DOWNGRADED_BODY = "本次交付已保留的结果，原目标仍有未完成部分。没有安排继续执行，也没有重放已完成或结果未知的动作。";
export class CompletionDeliveryError extends Error {
  constructor(cause?: unknown) { super("结果尚未送达明确的回报位置", { cause }); }
}

/** Runs in the same transaction as its exact result delivery receipt. */
export function applyCompletionDecision(options: WorkCompletionOptions, binding: WorkExecutionBindingDto, work: WorkDto,
  decision: WorkResultDecision, eventId: string): void {
  const { works, db } = options;
  let kind = decision.decision;
  const waitingForUser = kind === "ask" || kind === "wait";
  const reviewedTurn = db.prepare("SELECT context_json FROM work_completion_turns WHERE binding_id=?").get(binding.bindingId) as {context_json:string}|undefined;
  const reviewedQuestions: Array<{blockerId:string;reason:string}> = reviewedTurn ? JSON.parse(reviewedTurn.context_json).pendingQuestions ?? [] : [];
  let body = decision.reply;
  let notice: string | undefined;
  if (kind === "continue" && !continueMissing(options, binding, work, decision)) {
    // Body, nextStep and completion outcome must all describe what is delivered.
    kind = "deliver"; body = DOWNGRADED_BODY;
    notice = "没有重复执行已完成动作；无法可靠补做的部分已保留在结果中。";
  }
  if (kind === "wait") {
    const turn = db.prepare("SELECT context_json FROM work_completion_turns WHERE binding_id=?").get(binding.bindingId) as CompletionTurn | undefined;
    const context = turn && JSON.parse(turn.context_json);
    const messages: Array<{ text: string }> = context?.originalRequest?.userRequest?.messages ?? [];
    if (!decision.userInput || !messages.some(message => message.text.includes(decision.userInput!.requestExcerpt)))
      throw Error("等待用户输入必须有当前执行保存的原用户要求，不能依据模型报告或产物建立等待");
  }
  const questionSource = `user-input:${eventId}:question`;
  if (waitingForUser && !works.repo.listOpenBlockers(work.workId).some(item => item.sourceRef === questionSource)) {
    // A later reviewed result replaces only the exact earlier result-lane question
    // it observed. Unrelated/manual blockers and unknown effects remain untouched.
    for (const blocker of works.repo.listOpenBlockers(work.workId)) {
      if (blocker.kind !== "operational" || !blocker.waitingForUserInput || blocker.unknownExternalEffectRef
        || !reviewedQuestions.some(question => question.blockerId === blocker.blockerId && question.reason === blocker.reason)) continue;
      const previousId = /^user-input:completion:(.+):question$/.exec(blocker.sourceRef ?? "")?.[1];
      const previous = previousId && works.repo.getBinding(previousId);
      const previousTurn = previousId ? db.prepare("SELECT decision_json,state FROM work_completion_turns WHERE binding_id=?")
        .get(previousId) as {decision_json:string|null;state:string}|undefined : undefined;
      if (!previous || previous.bindingId === binding.bindingId || previous.workId !== work.workId
        || previous.botId !== binding.botId || previous.ownerEpoch !== binding.ownerEpoch || previousTurn?.state !== "asking"
        || !previousTurn.decision_json || !["ask","wait"].includes(JSON.parse(previousTurn.decision_json).decision)) continue;
      works.repo.clearBlocker(blocker.blockerId, work.workId, Date.now());
    }
    const current = works.getWork(work.workId)!;
    const response = works.reportBlocker({ kind: "bot", botId: current.ownerBotId, userId: current.userId, host: "background", grants: current.authorization }, {
      operationId: `${eventId}:question`, workId: current.workId, reason: decision.reply,
      kind: "operational", waitingForUserInput: true, userInput: { kind: "reply" },
      versionGuard: { expectedStateVersion: current.stateVersion, expectedIntentRevision: current.intentRevision, expectedOwnerEpoch: current.ownerEpoch },
    }, binding.bindingId);
    if (!response.ok) throw Error(response.message);
  }
  // A legacy "please accept" marker is not a user-information requirement.
  // Only a real result review may decide it is unnecessary; never clear unknown effects here.
  if (!waitingForUser) for (const blocker of works.repo.listOpenBlockers(work.workId)) {
    if (blocker.kind === "operational" && blocker.waitingForUserInput && !blocker.unknownExternalEffectRef
      && reviewedQuestions.some(question => question.blockerId === blocker.blockerId && question.reason === blocker.reason))
      works.repo.clearBlocker(blocker.blockerId, work.workId, Date.now());
  }
  // Semantic follow-up items are resolved by this exact follow-up result review,
  // never by a bare native completed status or by unrelated evidence.
  if (kind === "deliver" && decision.decision === "deliver" && decision.outcome === "completed") {
    const request = db.prepare("SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?").get(binding.taskId) as {continuation_plan_id:string|null}|undefined;
    const plan = request?.continuation_plan_id && works.partialResults.plans(work.workId).find(item => item.planId === request.continuation_plan_id);
    const source = plan && works.partialResults.list(work.workId).filter(item => item.bindingId === plan.sourceBindingId && plan.gapItemIds.includes(item.itemId));
    if (source && source.length && source.every(item => ["result_review", "result_read_followup"].includes(item.nativeStatus) && item.itemId.startsWith("result-followup:")))
      works.partialResults.record(binding, source.map(item => ({itemId:item.itemId,task:item.task,required:true,dependencies:[],criterionIds:[],
        nativeStatus:"result_review",outcome:"completed",artifactRefs:[],writeConflicts:[],summary:`前台对照本次补做结果完成核对：${body}`})));
  }
  const facts = kind === "deliver" ? works.automaticCompletion.outcome(binding.bindingId) : undefined;
  const notices = [...notice ? [notice] : [], ...facts && !facts.executionDelivered ? [facts.summary] : []];
  const outcome = kind !== "deliver" && decision.outcome === "completed" || decision.decision === "continue"
    || (decision.outcome === "completed" && !facts?.executionDelivered) ? "partial" : decision.outcome;
  if (outcome !== "completed" && decision.outcome === "completed") body = `${DOWNGRADED_BODY}${facts ? `\n${facts.summary}` : ""}`;
  try {
    const delivered = options.deliver({ bindingId: binding.bindingId, eventId, text: body,
      category: waitingForUser ? "decision" : "result", notices,
      completion: { outcome, nextStep: kind === "wait" ? "ask" : kind }, primaryArtifactRefs: decision.artifactRefs });
    if (!delivered) throw new CompletionDeliveryError();
  } catch (error) { throw error instanceof CompletionDeliveryError ? error : new CompletionDeliveryError(error); }
  if (kind === "deliver") {
    const summary = facts && !facts.executionDelivered ? `${body}\n${facts.summary}` : body;
    works.automaticCompletion.recordDelivery(binding.bindingId, summary, outcome, true);
    works.automaticCompletion.drain();
  } else works.automaticCompletion.consume(binding.bindingId);
  db.prepare("UPDATE work_completion_turns SET state=? WHERE binding_id=?").run(kind === "deliver" ? "delivered" : waitingForUser ? "asking" : "continued", binding.bindingId);
  options.wake();
}
function continueMissing({ works, db }: WorkCompletionOptions, binding: WorkExecutionBindingDto, work: WorkDto, decision: WorkResultDecision): boolean {
  if (!decision.missing.length) return false;
  // An unverified effect governs only the execution that produced it. Independent
  // read-only gaps still proceed; the unknown action itself is never replayed.
  const lineage = new Set(works.partialResults.recovery.ancestry(binding).map(item => item.bindingId));
  const hasUnknown = works.repo.listAdmissions(work.workId).some(item => item.state === "unknown" && !!item.bindingId && lineage.has(item.bindingId));
  // Model classification only narrows authority: admitted read follow-ups are
  // enforced read-only by the existing continuation-plan execution boundary.
  if (hasUnknown && decision.missing.some(item => item.readOnly !== true)) return false;
  const row = db.prepare("SELECT * FROM work_completion_turns WHERE binding_id=?").get(binding.bindingId) as CompletionTurn;
  const context = JSON.parse(row.context_json);
  const original = context.originalRequest?.userRequest?.messages?.map((item: { text: string }) => item.text).join("\n")
    || `${work.title}\n${work.goalDescription ?? ""}`;
  if (decision.missing.some(item => !original.includes(item.requestExcerpt))) return false;
  const prior = db.prepare(`SELECT count(*) count FROM work_completion_turns t JOIN work_execution_bindings b ON b.binding_id=t.binding_id
    WHERE b.work_id=? AND b.intent_revision=? AND b.input_snapshot_id=? AND t.state='continued'`).get(work.workId, work.intentRevision, work.inputSnapshotId) as { count: number };
  const progress = continuationProgress(works, work);
  // Only new durable facts (verified artifact bytes or completed current-version
  // subitems) buy another execution. A rephrased report is not progress.
  if (prior.count > 0 && lastContinuationProgress(db, work)?.fingerprint === progress) return false;
  const now = Date.now();
  // Team gaps retain the original member's identity and scope, never the owner's.
  if (works.teams.get(work.workId)) {
    if (!works.teams.continueMissing(binding, decision.missing, context.teamContinuationTargets, decision.reply)) return false;
    recordContinuationProgress(db, binding, work, progress, now);
    return true;
  }
  const items = decision.missing.map(item => ({ itemId: `result-followup:${hash([binding.bindingId,item.requestExcerpt,item.task])}`, task: item.task,
    required: true, dependencies: [], criterionIds: [], nativeStatus: decision.missing.every(item => item.readOnly === true) ? "result_read_followup" : "result_review", outcome: "not_started" as const,
    artifactRefs: [], writeConflicts: [], summary: `原请求仍缺此部分：${item.requestExcerpt}` }));
  works.partialResults.record(binding, items);
  const current = works.getWork(work.workId)!;
  const result = works.continueWork({ kind: "bot", botId: current.ownerBotId, userId: current.userId, host: "background", grants: current.authorization }, {
    operationId: `result-followup:${binding.bindingId}`, workId: work.workId, sourceBindingId: binding.bindingId,
    gapItemIds: items.map(item => item.itemId), reason: decision.reply,
    versionGuard: { expectedStateVersion: current.stateVersion, expectedIntentRevision: current.intentRevision, expectedOwnerEpoch: current.ownerEpoch },
  });
  if (!result.ok) throw Error(result.message);
  recordContinuationProgress(db, binding, work, progress, now);
  return true;
}
