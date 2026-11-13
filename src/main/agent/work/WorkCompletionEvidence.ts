import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import { completionArtifactEvidence } from "./WorkCompletionArtifactEvidence";
import { completionReviewInput } from "./WorkCompletionReviewTarget";
import { completionMilestoneEvidence } from "./WorkCompletionMilestoneEvidence";
import { workDeliveryFiles, workDeliveryResults } from "./WorkDeliveryArtifacts";

type CompletionFacts = NonNullable<ReturnType<WorkService["automaticCompletion"]["outcome"]>>;
const byId = <T>(items: T[], id: (item: T) => string): T[] => items.sort((a, b) => id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
export const completionFingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only decision inputs belong here. Poll times, metrics and unrelated state versions do not. */
export function completionEvidence(db: Database.Database, works: WorkService, binding: WorkExecutionBindingDto, facts: CompletionFacts) {
  const team = works.teams.get(binding.workId);
  const bindings = works.repo.listBindings(binding.workId);
  const lineage = new Set(works.partialResults.recovery.ancestry(binding).map(item => item.bindingId));
  const results = workDeliveryResults(works, binding);
  const resultFacts = (item: ReturnType<typeof works.repo.listDeliverables>[number]) => ({
    deliverableId: item.deliverableId, executionId: item.executionId, producerBotId: item.producerBotId,
    summary: item.summary, artifactRefs: [...item.artifactRefs].sort(), evidenceRefs: [...item.evidenceRefs].sort(),
    uncoveredScope: [...item.uncoveredScope].sort(), uncoveredCriterionIds: [...item.uncoveredCriterionIds].sort(),
    status: item.status, rejectedReason: item.rejectedReason, hasWriteConflicts: item.hasWriteConflicts, isSpeculation: item.isSpeculation,
  });
  const allResults = works.repo.listDeliverables(binding.workId).filter(item => item.intentRevision === binding.intentRevision
    && item.inputSnapshotId === binding.inputSnapshotId && item.ownerEpoch === binding.ownerEpoch);
  const blockers = byId(works.repo.listOpenBlockers(binding.workId).map(({ createdAt: _created, clearedAt: _cleared, ...item }) => item), item => item.blockerId);
  return {
    ...completionReviewInput(binding, JSON.parse(works.repo.executionInput(binding))),
    title: facts.work.title, goal: facts.work.goalDescription,
    results: byId(results.map(resultFacts), item => item.deliverableId),
    resultVerification: byId(allResults.map(resultFacts), item => item.deliverableId),
    previousResults: byId(allResults.filter(item => item.executionId !== binding.bindingId && item.status !== "superseded").map(resultFacts), item => item.deliverableId),
    availableFiles: byId(workDeliveryFiles(works, results).filter(file => file.openPath).map(({ ref, name }) => ({ ref, name })), item => item.ref),
    artifactEvidence: byId(completionArtifactEvidence(works, binding), item => item.ref),
    milestoneDeliveryEvidence: completionMilestoneEvidence(db, binding),
    executionFacts: { status: binding.status, settlementNote: binding.settlementNote, outputReceived: facts.executionDelivered,
      diagnosticSummary: facts.summary },
    criteria: byId(facts.work.criteria.map(item => ({ ...item, evidenceRefs: [...item.evidenceRefs].sort() })), item => item.id),
    continuationScope: [...binding.delegatedScope].sort(),
    teamContinuationTargets: works.teams.continuationTargets(binding),
    ...(team ? { teamReplanning: {
      planRevision: team.planRevision, ownerBotId: team.ownerBotId,
      ownerResponsibility: team.ownerResponsibility, members: team.members,
      executionPolicy: team.executionPolicy, maxConcurrency: team.maxConcurrency,
      availableBots: facts.work.workspacePath ? works.teams.foregroundCandidates(facts.work.userId, facts.work.ownerBotId, facts.work.workspacePath) : [],
      versionGuard: { expectedStateVersion: facts.work.stateVersion, expectedIntentRevision: facts.work.intentRevision, expectedOwnerEpoch: facts.work.ownerEpoch },
    } } : {}),
    blockers,
    pendingQuestions: blockers.filter(item => item.waitingForUserInput && item.kind === "operational" && !item.unknownExternalEffectRef)
      .map(({ blockerId, reason }) => ({ blockerId, reason })),
    actualMissing: byId(works.partialResults.gaps(binding.workId).map(({ createdAt: _created, ...item }) => item), item => item.factId),
    subitems: byId(works.partialResults.list(binding.workId).filter(item => item.intentRevision === binding.intentRevision
      && item.inputSnapshotId === binding.inputSnapshotId).map(({ createdAt: _created, ...item }) => item), item => item.factId),
    unknownEffects: byId(works.repo.listAdmissions(binding.workId).filter(item => item.state === "unknown").map(item => ({
      operationId: item.operationId, bindingId: item.bindingId, actionKind: item.actionKind,
      intentRevision: item.intentRevision, ownerEpoch: item.ownerEpoch,
      inputSnapshotId: bindings.find(binding => binding.bindingId === item.bindingId)?.inputSnapshotId,
      inCurrentLineage: Boolean(item.bindingId && lineage.has(item.bindingId)),
      invalidated: Boolean(bindings.find(binding => binding.bindingId === item.bindingId)?.invalidatedAt),
    })), item => item.operationId),
  };
}
