import type { WorkProjectionDto } from "@shared/bot-work";
import { isWorkEffectDiagnostic } from "@shared/work-effect-policy";
import { workStatusLabel } from "./botWorkspacePresentation";

export function publishedWorkReport(work: WorkProjectionDto) {
  const publication = work.publishedReport;
  return work.inputSnapshotBound && publication?.intentRevision === work.intentRevision
    && publication.inputSnapshotId === work.inputSnapshotId && publication.report.current
    && publication.report.completion ? publication : undefined;
}

export function workUserQuestions(work: WorkProjectionDto) {
  if (work.lifecycle === "closed" || work.lifecycle === "closing") return [];
  return work.blockers.filter(blocker => blocker.status === "open" && blocker.waitingForUserInput
    && blocker.kind === "operational" && !isWorkEffectDiagnostic(blocker) && !blocker.unknownExternalEffectRef
    && (!blocker.reasonCode || blocker.reasonCode === "user-input") && !blocker.blockerId.startsWith("continuation:"));
}

/** One decision supplies both the header and its explanation. */
function detailPresentation(work: WorkProjectionDto): { label: string; activity?: string } {
  const completion = publishedWorkReport(work)?.report.completion;
  if (work.lifecycle === "closed") return { label: work.closureConclusion === "ended_unsuccessfully" && completion?.outcome === "partial"
    ? "部分完成 · 已结束" : workStatusLabel(work) };
  if (work.lifecycle === "closing") return { label: "正在收尾", activity: "正在收尾，核对已经执行的操作与最终结果。" };
  if (workUserQuestions(work).length) return { label: work.lifecycle === "paused" ? "等你补充 · 已暂停" : "等你补充" };
  if (work.lifecycle === "paused") return { label: "已暂停", activity: "任务已暂停，已有结果会保留。恢复后继续处理。" };
  const runtime = work.runtimeObservations ?? [];
  const current = work.executions.filter(item => item.intentRevision === work.intentRevision
    && item.inputSnapshotId === work.inputSnapshotId && !item.invalidatedAt && item.status !== "invalidated");
  if (runtime.some(item => item.state === "recovering")) return { label: "恢复中", activity: "Bot 正在恢复执行，已确认的结果会保留。" };
  if (current.some(item => item.status === "running" || item.status === "submitted") || runtime.some(item => item.state === "running")) {
    return { label: "正在执行", activity: work.team ? "成员正在按分工处理，负责人会汇总结果。" : "Bot 正在处理这项委托，有结果后会更新。" };
  }
  if (work.blockers.some(item => item.status === "open" && !isWorkEffectDiagnostic(item))) {
    return { label: "执行受阻", activity: "任务遇到阻碍，当前尚未完成。" };
  }
  if (current.some(item => item.status === "pending") || runtime.some(item => item.state === "waiting")) {
    return { label: "等待执行", activity: "正在等待执行资源，尚未开始本次处理。" };
  }
  if (work.mode === "once" && completion?.nextStep === "continue") {
    return { label: "继续处理中", activity: "已有结果已保留，Bot 会继续补齐剩余工作。" };
  }
  if (work.mode === "once" && completion?.nextStep === "deliver") {
    switch (completion.outcome) {
      case "completed": return { label: "正在收尾", activity: "结果已核对，正在完成收尾。" };
      case "partial": return { label: "部分完成", activity: "已交付当前可确认的部分，整项委托尚未完成。" };
      case "unknown": return { label: "结果待核实", activity: "执行结果已保留，是否达成目标尚未核实。" };
    }
  }
  if (runtime.some(item => item.state === "interrupted") || current.some(item => ["failed", "unknown", "stopped"].includes(item.status))) {
    return { label: "执行遇到问题", activity: "执行遇到问题，当前尚未完成。已取得的结果和问题原因保留在过程记录中。" };
  }
  if (work.mode === "watch") return { label: workStatusLabel(work) };
  if (current.length || work.deliverables.some(item => item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId)) {
    return { label: "正在核对结果", activity: "执行结果已返回，正在核对是否完成原委托。" };
  }
  return { label: "尚未执行", activity: "尚未开始执行，当前没有可交付的结果。" };
}

export function workDetailStatus(work: WorkProjectionDto): string {
  return detailPresentation(work).label;
}

export function workActivitySummary(work: WorkProjectionDto): string | undefined {
  return detailPresentation(work).activity;
}
