import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import type { WorkDeliverableDto, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { GeneratedArtifact, WorkMilestoneDto, WorkMilestoneFileDto, WorkMilestonesProjectionDto } from "../../../shared/bot-work-phase3";
import type { WorkRepository } from "./WorkRepository";
import type { WorkPartialResults } from "./WorkPartialResults";
import type { WorkGeneratedArtifacts } from "./WorkGeneratedArtifacts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const UNSETTLED: ReadonlySet<string> = new Set(["pending", "submitted", "running", "unknown"]);
/** Detail reads stay bounded: enough to answer "这次先能用什么", not a transcript. */
const MILESTONE_LIMIT = 40;

export interface WorkMilestoneSources {
  repo: Pick<WorkRepository, "listDeliverables" | "listBlockers">;
  partialResults: Pick<WorkPartialResults, "list" | "gapsForWork">;
  generatedArtifacts: Pick<WorkGeneratedArtifacts, "listForWork">;
}

/**
 * Read-only milestone projection over facts that already exist: item results,
 * partial deliverables and gaps. It never writes, dispatches or accepts anything;
 * a completed subitem stays "可用证据", never "整个事项已完成".
 */
export class WorkMilestones {
  constructor(private readonly sources: WorkMilestoneSources) {}

  project(work: WorkDto, executions: readonly WorkExecutionBindingDto[]): WorkMilestonesProjectionDto {
    const current = (value: { intentRevision: number; inputSnapshotId: string }) =>
      value.intentRevision === work.intentRevision && value.inputSnapshotId === work.inputSnapshotId;
    const bindings = new Map(executions.filter(binding => binding.invalidatedAt === undefined
      && binding.status !== "invalidated" && current(binding)).map(binding => [binding.bindingId, binding]));
    const deliverables = this.sources.repo.listDeliverables(work.workId);
    const artifacts = this.sources.generatedArtifacts.listForWork(work);
    const requiresUserInput = this.sources.repo.listBlockers(work.workId)
      .some(blocker => blocker.status === "open" && blocker.waitingForUserInput);
    const items = this.sources.partialResults.list(work.workId)
      .filter(item => current(item) && bindings.has(item.bindingId) && item.outcome === "completed");
    const deliverableById = new Map(deliverables.filter(item => current(item) && bindings.has(item.executionId))
      .map(item => [item.deliverableId, item]));
    const milestones: WorkMilestoneDto[] = [];
    const published = new Set<string>();
    for (const item of items) {
      // The partial deliverable is the host-published form of a verified item.
      // Without it there is no durable artifact/deliverable identity to report.
      if (!item.deliverableId) continue;
      const deliverable = deliverableById.get(item.deliverableId);
      if (!deliverable || deliverable.status === "superseded" || deliverable.status === "rejected") continue;
      const binding = bindings.get(item.bindingId)!;
      milestones.push(this.milestone(work, binding, item.itemId, item.task, item.summary || deliverable.summary,
        item.artifactRefs, item.deliverableId, deliverable, artifacts, requiresUserInput, item.createdAt));
      published.add(item.deliverableId);
    }
    // A restart may find the published partial deliverable without its item row;
    // report that exact fact once instead of dropping it from the conversation.
    for (const deliverable of deliverables) {
      if (!deliverable.deliverableId.startsWith("partial:") || published.has(deliverable.deliverableId)) continue;
      if (deliverable.status === "superseded" || deliverable.status === "rejected") continue;
      const binding = bindings.get(deliverable.executionId);
      if (!binding || !current(deliverable)) continue;
      milestones.push(this.milestone(work, binding, deliverable.deliverableId, deliverable.summary, deliverable.summary,
        deliverable.artifactRefs, deliverable.deliverableId, deliverable, artifacts, requiresUserInput, deliverable.createdAt));
    }
    milestones.sort((left, right) => left.createdAt - right.createdAt || left.milestoneId.localeCompare(right.milestoneId));
    const ready = milestones.slice(-MILESTONE_LIMIT);
    const readyDeliverables = new Set(ready.flatMap(item => item.deliverableId ? [item.deliverableId] : []));
    const gaps = this.sources.partialResults.gapsForWork(work).map(item => ({ itemId: item.itemId, bindingId: item.bindingId,
      task: item.task, outcome: item.outcome, required: item.required }));
    // "Covered" is only the required scope that also has a published partial fact.
    const covered = items.filter(item => item.required && item.deliverableId !== undefined
      && readyDeliverables.has(item.deliverableId)).slice(-MILESTONE_LIMIT)
      .map(item => ({ itemId: item.itemId, task: item.task, ...(item.deliverableId ? { deliverableId: item.deliverableId } : {}) }));
    const running = executions.some(binding => UNSETTLED.has(binding.status)
      && binding.invalidatedAt === undefined && current(binding));
    return {
      intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId,
      ready, covered, openGaps: gaps,
      nextStep: gaps.length
        ? `已核验 ${ready.length} 项子步骤${running ? "，后台仍在执行" : ""}；仍有 ${gaps.length} 项必要缺口待核对`
        : running ? `后台仍在执行；已核验 ${ready.length} 项子步骤，最终成果尚未交付`
          : ready.length ? `已核验 ${ready.length} 项子步骤成果，等待整体收尾与验收` : "尚无已核验的可用子步骤成果",
      requiresUserInput,
      digest: hash([work.workId, work.intentRevision, work.inputSnapshotId,
        ready.map(item => [item.milestoneId, item.itemId, item.bindingId, item.deliverableId ?? null, item.task, item.summary, item.artifactRefs, item.files]),
        gaps.map(item => [item.itemId, item.bindingId, item.outcome])]),
      createdAt: ready[0]?.createdAt ?? work.createdAt, updatedAt: work.updatedAt,
    };
  }

  private milestone(work: WorkDto, binding: WorkExecutionBindingDto, itemId: string, task: string, summary: string,
    itemRefs: string[], deliverableId: string, deliverable: WorkDeliverableDto | undefined,
    artifacts: Array<GeneratedArtifact & { bindingId: string }>, requiresUserInput: boolean, createdAt: number): WorkMilestoneDto {
    const artifactRefs = [...new Set([...(deliverable?.artifactRefs ?? []), ...itemRefs])];
    return { milestoneId: `milestone:${hash([work.workId, binding.bindingId, itemId])}`,
      bindingId: binding.bindingId, itemId, task, summary, artifactRefs,
      files: projectFiles(artifactRefs, artifacts, binding),
      deliverableId, requiresUserInput, createdAt };
  }
}

/** Stable version for one binding's merged report; new verified items change it. */
export function workMilestoneVersion(bindingId: string, milestones: readonly WorkMilestoneDto[]): string {
  return JSON.stringify([bindingId, milestones.map(item => [item.milestoneId, item.itemId, item.task, item.summary, item.artifactRefs, item.files])]);
}

/** Resolve host-registered versions only: a raw path is a claim until registered. */
function projectFiles(refs: readonly string[], artifacts: readonly (GeneratedArtifact & { bindingId: string })[],
  binding: WorkExecutionBindingDto): WorkMilestoneFileDto[] {
  const files = new Map<string, WorkMilestoneFileDto>();
  for (const ref of refs) {
    const resolved = !isAbsolute(ref) && binding.workspaceBinding ? resolve(binding.workspaceBinding, ref) : ref;
    const candidates = artifacts.filter(item => item.bindingId === binding.bindingId).sort((a, b) => b.sourceEntryId - a.sourceEntryId);
    const artifact = candidates.find(item => item.snapshotPath === ref || item.snapshotPath === resolved)
      ?? candidates.filter(item => item.path === ref || item.path === resolved)
        .sort((left, right) => right.sourceEntryId - left.sourceEntryId || right.registeredAt - left.registeredAt)[0];
    const refValue = artifact?.snapshotPath ?? artifact?.path ?? ref;
    if (files.has(refValue)) continue;
    files.set(refValue, { ref: refValue, name: basename(artifact?.path ?? refValue) || refValue,
      ...(artifact ? { ...(artifact.snapshotPath ? { openPath: artifact.snapshotPath, ...(artifact.previewManifestPath ? { previewManifestPath: artifact.previewManifestPath } : {}) } : {}), digest: artifact.digest, immutable: artifact.snapshotPath !== undefined } : { immutable: false }) });
  }
  return [...files.values()];
}
