import { createHash } from "node:crypto";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkResultDecision } from "./BotWorkResultTurn";
import type { CompletionTurn, WorkCompletionOptions } from "./WorkCompletionCoordinator";
import { continuationProgress, lastContinuationProgress, recordContinuationProgress } from "./WorkContinuationProgress";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Real durable progress may extend a result lane, but never without bound. */
const CONTINUATION_PROGRESS_CAP = 4;
/** A host downgrade must not keep promising the continuation it just refused. */
const CONTINUATION_PROMISE = /(接下来|下一步|随后|稍后|一会儿|之后|马上|接着|后续|正在|仍在|仍会|会|将)[^。！？!?；;\n]{0,24}(继续|续做|补[做齐上充跑完]|再(?:执行|尝试|核对|处理|做)|重新执行|重新核对|推进|处理剩余|完成剩余)|请稍(?:候|等)/;
const DOWNGRADED_BODY = "本次只交付已经确认的成果；未完成部分没有继续执行，也没有重放已完成的动作。";
/** Sentence-level strip keeps already-true content, never a future promise. */
function withoutContinuationPromise(reply: string): string {
  const sentences = reply.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) ?? [reply];
  return sentences.filter(sentence => !CONTINUATION_PROMISE.test(sentence)).join("").trim() || DOWNGRADED_BODY;
}

/** Runs in the same transaction as its exact result delivery receipt. */
export function applyCompletionDecision(options: WorkCompletionOptions, binding: WorkExecutionBindingDto, work: WorkDto,
  decision: WorkResultDecision, eventId: string): void {
  const { works, db } = options;
  let kind = decision.decision;
  let body = decision.reply;
  let notice: string | undefined;
  if (kind === "continue" && !continueMissing(options, binding, work, decision)) {
    // Body, nextStep and completion outcome must all describe what is delivered.
    kind = "deliver"; body = withoutContinuationPromise(decision.reply);
    notice = "没有重复执行已完成动作；无法可靠补做的部分已保留在结果中。";
  }
  if (kind === "ask" && !works.repo.listOpenBlockers(work.workId).some(item => item.waitingForUserInput && item.kind === "operational" && !item.unknownExternalEffectRef)) {
    const current = works.getWork(work.workId)!;
    const response = works.reportBlocker({ kind: "bot", botId: current.ownerBotId, userId: current.userId, host: "background", grants: current.authorization }, {
      operationId: `${eventId}:question`, workId: current.workId, reason: decision.reply,
      kind: "operational", waitingForUserInput: true, userInput: { kind: "reply" },
      versionGuard: { expectedStateVersion: current.stateVersion, expectedIntentRevision: current.intentRevision, expectedOwnerEpoch: current.ownerEpoch },
    });
    if (!response.ok) throw Error(response.message);
  }
  // A legacy "please accept" marker is not a user-information requirement.
  // Only a real result review may decide it is unnecessary; never clear unknown effects here.
  const reviewedTurn = db.prepare("SELECT context_json FROM work_completion_turns WHERE binding_id=?").get(binding.bindingId) as {context_json:string}|undefined;
  const reviewedQuestions: Array<{blockerId:string;reason:string}> = reviewedTurn ? JSON.parse(reviewedTurn.context_json).pendingQuestions ?? [] : [];
  if (decision.decision !== "ask") for (const blocker of works.repo.listOpenBlockers(work.workId)) {
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
    if (source && source.length && source.every(item => item.nativeStatus === "result_review" && item.itemId.startsWith("result-followup:")))
      works.partialResults.record(binding, source.map(item => ({itemId:item.itemId,task:item.task,required:true,dependencies:[],criterionIds:[],
        nativeStatus:"result_review",outcome:"completed",artifactRefs:[],writeConflicts:[],summary:`前台对照本次补做结果完成核对：${body}`})));
  }
  const facts = kind === "deliver" ? works.automaticCompletion.outcome(binding.bindingId) : undefined;
  const notices = [...notice ? [notice] : [], ...facts && !facts.executionDelivered ? [facts.summary] : []];
  const outcome = kind !== "deliver" && decision.outcome === "completed" || decision.decision === "continue"
    || (decision.outcome === "completed" && !facts?.executionDelivered) ? "partial" : decision.outcome;
  const delivered = options.deliver({ bindingId: binding.bindingId, eventId, text: body,
    category: kind === "ask" ? "decision" : "result", notices,
    completion: { outcome, nextStep: kind }, primaryArtifactRefs: decision.artifactRefs });
  if (!delivered) throw Error("结果尚未送达明确的回报位置");
  if (kind === "deliver") {
    const summary = facts && !facts.executionDelivered ? `${body}\n${facts.summary}` : body;
    works.automaticCompletion.recordDelivery(binding.bindingId, summary, outcome, true);
    works.automaticCompletion.drain();
  } else works.automaticCompletion.consume(binding.bindingId);
  db.prepare("UPDATE work_completion_turns SET state=? WHERE binding_id=?").run(kind === "deliver" ? "delivered" : kind === "ask" ? "asking" : "continued", binding.bindingId);
  options.wake();
}
function continueMissing({ works, db }: WorkCompletionOptions, binding: WorkExecutionBindingDto, work: WorkDto, decision: WorkResultDecision): boolean {
  if (!decision.missing.length) return false;
  // An unverified effect governs only the execution that produced it. Independent
  // read-only gaps still proceed; the unknown action itself is never replayed.
  const lineage = new Set(works.partialResults.recovery.ancestry(binding).map(item => item.bindingId));
  if (works.repo.listAdmissions(work.workId).some(item => item.state === "unknown" && !!item.bindingId && lineage.has(item.bindingId))) return false;
  const row = db.prepare("SELECT * FROM work_completion_turns WHERE binding_id=?").get(binding.bindingId) as CompletionTurn;
  const context = JSON.parse(row.context_json);
  const original = context.originalRequest?.userRequest?.messages?.map((item: { text: string }) => item.text).join("\n")
    || `${work.title}\n${work.goalDescription ?? ""}`;
  if (decision.missing.some(item => !original.includes(item.requestExcerpt))) return false;
  const prior = db.prepare(`SELECT count(*) count FROM work_completion_turns t JOIN work_execution_bindings b ON b.binding_id=t.binding_id
    WHERE b.work_id=? AND b.intent_revision=? AND b.input_snapshot_id=? AND t.state='continued'`).get(work.workId, work.intentRevision, work.inputSnapshotId) as { count: number };
  if (prior.count >= CONTINUATION_PROGRESS_CAP) return false; // Honest partial delivery ends an endless chain.
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
    required: true, dependencies: [], criterionIds: [], nativeStatus: "result_review", outcome: "not_started" as const,
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
