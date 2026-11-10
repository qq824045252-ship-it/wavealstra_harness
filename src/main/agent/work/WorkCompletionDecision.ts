import { createHash } from "node:crypto";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkResultDecision } from "./BotWorkResultTurn";
import type { CompletionTurn, WorkCompletionOptions } from "./WorkCompletionCoordinator";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Runs in the same transaction as its exact result delivery receipt. */
export function applyCompletionDecision(options: WorkCompletionOptions, binding: WorkExecutionBindingDto, work: WorkDto,
  decision: WorkResultDecision, eventId: string): void {
  const { works, db } = options;
  let kind = decision.decision;
  let notice: string | undefined;
  if (kind === "continue" && !continueMissing(options, binding, work, decision)) {
    kind = "deliver"; notice = "没有重复执行已完成动作；无法可靠补做的部分已保留在结果中。";
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
  // Semantic follow-up items are resolved by this exact follow-up result review,
  // never by a bare native completed status or by unrelated evidence.
  if (kind === "deliver" && decision.outcome === "completed") {
    const request = db.prepare("SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?").get(binding.taskId) as {continuation_plan_id:string|null}|undefined;
    const plan = request?.continuation_plan_id && works.partialResults.plans(work.workId).find(item => item.planId === request.continuation_plan_id);
    const source = plan && works.partialResults.list(work.workId).filter(item => item.bindingId === plan.sourceBindingId && plan.gapItemIds.includes(item.itemId));
    if (source && source.length && source.every(item => item.nativeStatus === "result_review" && item.itemId.startsWith("result-followup:")))
      works.partialResults.record(binding, source.map(item => ({itemId:item.itemId,task:item.task,required:true,dependencies:[],criterionIds:[],
        nativeStatus:"result_review",outcome:"completed",artifactRefs:[],writeConflicts:[],summary:`前台对照本次补做结果完成核对：${decision.reply}`})));
  }
  const facts = kind === "deliver" ? works.automaticCompletion.outcome(binding.bindingId) : undefined;
  const notices = [...notice ? [notice] : [], ...facts?.conclusion === "ended_unsuccessfully" ? [facts.summary] : []];
  const delivered = options.deliver({ bindingId: binding.bindingId, eventId, text: decision.reply,
    category: kind === "ask" ? "decision" : "result", notices });
  if (!delivered) throw Error("结果尚未送达明确的回报位置");
  if (kind === "deliver") {
    works.automaticCompletion.recordDelivery(binding.bindingId, decision.reply, decision.decision === "continue" ? "partial" : decision.outcome);
    works.automaticCompletion.drain();
  } else works.automaticCompletion.consume(binding.bindingId);
  db.prepare("UPDATE work_completion_turns SET state=? WHERE binding_id=?").run(kind === "deliver" ? "delivered" : kind === "ask" ? "asking" : "continued", binding.bindingId);
  options.wake();
}
function continueMissing({ works, db }: WorkCompletionOptions, binding: WorkExecutionBindingDto, work: WorkDto, decision: WorkResultDecision): boolean {
  if (!decision.missing.length || works.teams.get(work.workId)
    || works.repo.listAdmissions(work.workId).some(item => item.state === "unknown")) return false;
  const row = db.prepare("SELECT * FROM work_completion_turns WHERE binding_id=?").get(binding.bindingId) as CompletionTurn;
  const context = JSON.parse(row.context_json);
  const original = context.originalRequest?.userRequest?.messages?.map((item: { text: string }) => item.text).join("\n")
    || `${work.title}\n${work.goalDescription ?? ""}`;
  if (decision.missing.some(item => !original.includes(item.requestExcerpt))) return false;
  const prior = db.prepare(`SELECT count(*) count FROM work_completion_turns t JOIN work_execution_bindings b ON b.binding_id=t.binding_id
    WHERE b.work_id=? AND b.intent_revision=? AND b.input_snapshot_id=? AND t.state='continued'`).get(work.workId, work.intentRevision, work.inputSnapshotId) as { count: number };
  if (prior.count >= 2) return false; // A result rephrasing loop must end with honest partial delivery.
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
  return true;
}
