import type { WorkGoalSourceDto, WorkWatchRuleDto } from "../../../shared/bot-work";

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
    subscriptions: normalizeTexts(input.subscriptions),
    cronExpression: input.cronExpression?.trim() || undefined,
    timezone: input.timezone?.trim() || undefined,
    catchUpPolicy,
    maxMergeWaitMs: input.maxMergeWaitMs && input.maxMergeWaitMs > 0 ? input.maxMergeWaitMs : 60_000,
    maxQueueDepth: input.maxQueueDepth && input.maxQueueDepth > 0 ? input.maxQueueDepth : 100,
    stopConditionText: input.stopConditionText?.trim() || undefined,
    nextWakeAt: input.nextWakeAt,
  };
}
