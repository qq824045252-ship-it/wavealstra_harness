import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkClosureReviewRequest } from "../../../shared/work-closure-review";
import { isRequiredCriterion, type WorkDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import { completionArtifactEvidence } from "./WorkCompletionArtifactEvidence";
import { completionReviewInput } from "./WorkCompletionReviewTarget";
import { workDeliveryFiles, workDeliveryResults } from "./WorkDeliveryArtifacts";
import { resultDecisionSchema, type WorkResultDecision } from "./WorkResultDecision";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type ClosureReviewEvidence = ReturnType<typeof prepareClosureReview>;

/** A read-only review of the existing execution. It cannot dispatch or reopen work. */
export function prepareClosureReview(db: Database.Database, works: WorkService, request: WorkClosureReviewRequest) {
  const work = works.getWork(request.workId);
  if (!work || work.lifecycle !== "closed" || work.mode !== "once" || work.closureConclusion !== "ended_unsuccessfully"
    || work.closedAt === undefined || work.closeOperationId !== request.expectedCloseOperationId || !work.closeOperationId.startsWith("automatic-completion:"))
    throw Error("仅可复核宿主自动结案的未达成事项，不能改写用户结案或取消记录");
  const binding = works.repo.getBinding(work.closeOperationId.slice("automatic-completion:".length));
  if (!binding || binding.workId !== work.workId || binding.botId !== work.ownerBotId || binding.ownerEpoch !== work.ownerEpoch
    || binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId
    || binding.invalidatedAt || binding.status !== "completed") throw Error("原结案缺少当前版本的真实完成执行");
  if (works.repo.listAdmissions(work.workId).some(item => ["admitted", "unknown"].includes(item.state))
    || works.repo.listBindings(work.workId).some(item => !item.invalidatedAt && ["pending", "submitted", "running", "unknown"].includes(item.status))
    || works.repo.listOpenBlockers(work.workId).length || works.partialResults.gaps(work.workId).length)
    throw Error("仍有业务缺口、阻碍或未知效果，不能通过投递职责复核改为成功");
  const prior = z.object({ decision_json: z.string(), summary: z.string(), outcome: z.enum(["partial", "unknown"]) }).optional().parse(db.prepare(
    `SELECT t.decision_json,d.summary,d.outcome FROM work_completion_turns t
      JOIN work_automatic_completion_deliveries d ON d.binding_id=t.binding_id
      WHERE t.binding_id=? AND t.state='delivered' AND d.goal_reviewed=1`).get(binding.bindingId));
  if (!prior) throw Error("原结案不是已交付的宿主目标审查，不能更改");
  const previousDecision = resultDecisionSchema.parse(JSON.parse(prior.decision_json));
  if (previousDecision.decision !== "deliver" || previousDecision.outcome === "completed") throw Error("原审查不符合投递职责误判复核范围");
  const target = completionReviewInput(binding, JSON.parse(works.repo.executionInput(binding)));
  if (!target.hostDeliveryContext) throw Error("缺少原请求的可信宿主回传路线，不能推定由宿主代发");
  const selected = new Set(previousDecision.artifactRefs ?? []);
  const artifactEvidence = completionArtifactEvidence(works, binding).filter(item => selected.has(item.ref));
  if (!selected.size || artifactEvidence.length !== selected.size || artifactEvidence.some(item => item.state !== "text" || item.truncated))
    throw Error("原审查选定的不可变成果已变化或不能核验，不能更正结案");
  const results = workDeliveryResults(works, binding);
  const selectedResults = results.filter(result => workDeliveryFiles(works, [result]).some(file => selected.has(file.ref)));
  if (selectedResults.some(result => result.uncoveredCriterionIds.length || result.uncoveredScope.length
      || result.isSpeculation || result.hasWriteConflicts)
    || work.criteria.some(criterion => isRequiredCriterion(criterion) && ["failed", "blocked"].includes(criterion.status)))
    throw Error("成果已有明确业务缺项、未覆盖验收项或未核实冲突，不能通过投递职责复核改为成功");
  const context = { ...target, title: work.title, goal: work.goalDescription,
    results: results.map(item => ({ deliverableId: item.deliverableId, executionId: item.executionId, status: item.status,
      summary: item.summary, artifactRefs: item.artifactRefs.filter(ref => selected.has(ref)),
      uncoveredScope: item.uncoveredScope, uncoveredCriterionIds: item.uncoveredCriterionIds,
      isSpeculation: item.isSpeculation, hasWriteConflicts: item.hasWriteConflicts })),
    availableFiles: workDeliveryFiles(works, results).filter(file => selected.has(file.ref)).map(({ ref, name }) => ({ ref, name })),
    artifactEvidence, criteria: work.criteria, continuationScope: [], teamContinuationTargets: [], pendingQuestions: [], unknownEffects: [],
    closedWorkReview: { kind: "host_delivery_responsibility", originalConclusion: work.closureConclusion,
      originalSummary: work.closureSummary, originalDecision: previousDecision,
      instructions: "只核对原业务成果与原会话回传职责。不得重跑业务、扩大分工或把渠道失败改称成功。" } };
  return { work, binding, context, fingerprint: hash({ stateVersion: work.stateVersion, closeOperationId: work.closeOperationId, context }) };
}

/** Called only inside the existing guarded Work control transaction. */
export function recordClosureCorrection(db: Database.Database, works: WorkService, work: WorkDto,
  request: WorkClosureReviewRequest, evidence: ClosureReviewEvidence, proposal: WorkResultDecision, now: number): WorkDto {
  const current = prepareClosureReview(db, works, request);
  if (current.fingerprint !== evidence.fingerprint) throw Error("复核期间原成果或投递事实发生变化，请刷新后重试");
  const decision = resultDecisionSchema.parse(proposal);
  if (decision.decision !== "deliver" || decision.outcome !== "completed" || decision.correction?.kind !== "host_delivery_responsibility"
    || !decision.artifactRefs?.length || decision.missing.length || decision.userInput || decision.waitPlan || decision.followUp
    || decision.artifactRefs.some(ref => !evidence.context.availableFiles.some(file => file.ref === ref)))
    throw Error("只读复核没有证明原业务完成或没有确认宿主回传职责误判，原结论保留");
  const operationId = `closure-review:${request.requestId}`;
  db.exec(`CREATE TABLE IF NOT EXISTS work_closure_review_corrections (
    operation_id TEXT PRIMARY KEY,work_id TEXT NOT NULL,binding_id TEXT NOT NULL,
    original_close_operation_id TEXT NOT NULL,original_conclusion TEXT NOT NULL,original_summary TEXT,
    original_closed_at INTEGER NOT NULL,evidence_json TEXT NOT NULL,decision_json TEXT NOT NULL,created_at INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO work_closure_review_corrections VALUES(?,?,?,?,?,?,?,?,?,?)`).run(operationId,work.workId,evidence.binding.bindingId,
    work.closeOperationId,work.closureConclusion,work.closureSummary ?? null,work.closedAt,JSON.stringify(evidence.context),JSON.stringify(decision),now);
  const states: Record<string,string> = { not_requested:"未请求",pending:"待投递",sent:"已有发送回执",unknown:"待核对",failed:"失败",unsupported:"不支持" };
  const channels: Record<string,string> = {qq:"QQ",discord:"Discord",dingtalk:"钉钉"};
  const delivery = evidence.context.hostDeliveryContext as import("./WorkDeliveryContext").WorkDeliveryContext;
  const deliverySummary = delivery.routes.map(route => `${channels[route.channel] ?? route.channel}文字${states[route.summaryDelivery.state]}；文件${
    route.fileDelivery.capability === "unsupported" ? "不支持，未通过此渠道发送，保留在 MyBuddy" : states[route.fileDelivery.state]}`).join("。 ");
  const next: WorkDto = { ...work, closureConclusion:"succeeded",closureSummary:`复核更正：${decision.reply}\n宿主回传事实：${deliverySummary}。原始自动结案与投递失败记录保留。`,
    stateVersion:work.stateVersion+1,updatedAt:now };
  works.repo.updateWork(next);
  // Retire send authority only. Old deliveries/attempts/receipts remain unchanged.
  db.prepare(`UPDATE work_notification_identity SET semantic_validity='superseded' WHERE notification_id IN
    (SELECT notification_id FROM work_notifications WHERE work_id=?)`).run(work.workId);
  return next;
}
