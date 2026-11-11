import { WORK_MAX_CRITERIA } from "../../../shared/bot-work";
import type { CreateWorkParams, WorkCriterionDto, WorkDto, WorkDeliverableDto, WorkExecutionBindingDto, WorkGoalSourceDto, WorkWatchRuleDto } from "../../../shared/bot-work";

export function normalizeTexts(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].slice(0, 256);
}

export function normalizeSources(values: WorkGoalSourceDto[] | undefined, now: number): WorkGoalSourceDto[] {
  // A source entry without an immutable snapshot identity cannot prove later evidence.
  return (values ?? [])
    .filter(source => source.sourceType && source.sourceRef?.trim() && source.inputSnapshotId?.trim())
    .map(source => ({
      sourceType: source.sourceType,
      sourceRef: source.sourceRef.trim(),
      inputSnapshotId: source.inputSnapshotId.trim(),
      observedAt: source.observedAt || now,
    }))
    .slice(0, 16);
}

export function normalizeWatchRule(input: Partial<WorkWatchRuleDto> | undefined): WorkWatchRuleDto | undefined {
  if (!input) return undefined;
  const catchUpPolicy = input.catchUpPolicy ?? "latest";
  return {
    requestedOutcome: input.requestedOutcome, executionMode: input.executionMode ?? (input.requestedOutcome === "one_time" ? "continuous" : undefined), eventSource: input.eventSource, eventTarget: input.eventTarget,
    eventFilter: input.eventFilter, triggerMode: input.triggerMode,
    endsAt: input.endsAt,
    subscriptions: normalizeTexts(input.subscriptions ?? (input.eventSource ? [input.eventSource] : input.cronExpression || input.nextWakeAt !== undefined || input.executionMode === "continuous" ? ["cron"] : [])),
    cronExpression: input.cronExpression?.trim() || undefined,
    scheduleBasis: input.scheduleBasis,
    scheduleRationale: input.scheduleRationale?.trim().slice(0, 1000) || undefined,
    timezone: input.timezone?.trim() || undefined,
    catchUpPolicy,
    notificationMode: input.notificationMode,
    notifyInitial: input.notifyInitial,
    maxMergeWaitMs: input.maxMergeWaitMs && input.maxMergeWaitMs > 0 ? input.maxMergeWaitMs : 60_000,
    maxQueueDepth: input.maxQueueDepth && input.maxQueueDepth > 0 ? input.maxQueueDepth : 100,
    stopConditionText: input.stopConditionText?.trim() || undefined,
    nextWakeAt: input.nextWakeAt,
  };
}

export function normalizeCriteria(
  inputs: CreateWorkParams["criteria"],
  intentRevision: number,
  now: number,
): WorkCriterionDto[] | string {
  const criteria = (inputs ?? []).slice(0, WORK_MAX_CRITERIA);
  const next: WorkCriterionDto[] = [];
  for (const input of criteria) {
    const text = input.text?.trim().slice(0, 500);
    if (!text) continue;
    if (input.status && input.status !== "pending") return "创建事项时验收条件只能是待验收状态";
    next.push({
      id: input.id?.trim() || `criterion-${now}-${next.length}`,
      text,
      ...(input.origin === "assistant_proposal" ? { origin: input.origin } : {}),
      status: "pending",
      requiredIntentRevision: intentRevision,
      requiresRealEnvironmentCheck: Boolean(input.requiresRealEnvironmentCheck),
      requiredEnvironment: input.requiredEnvironment?.trim() || undefined,
      evidenceRefs: [],
    });
  }
  return next;
}

export function currentAcceptedDeliverableIds(work: WorkDto, deliverables: WorkDeliverableDto[], bindings: WorkExecutionBindingDto[]): string[] {
  const validBindings = new Set(bindings.filter(binding => binding.invalidatedAt === undefined && binding.status !== "invalidated")
    .map(binding => binding.bindingId));
  const current = new Set(deliverables.filter(deliverable => deliverable.status === "accepted"
    && deliverable.intentRevision === work.intentRevision && deliverable.inputSnapshotId === work.inputSnapshotId
    && validBindings.has(deliverable.executionId)).map(deliverable => deliverable.deliverableId));
  return work.acceptedDeliverableIds.filter(id => current.has(id));
}

export function matchesFilter(filter: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter ?? {})) {
    if (expected === undefined) continue;
    const actual = payload[key];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}
