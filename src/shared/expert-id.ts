export const REMOVED_EXPERT_TEAM_PREFIX = "team:";

export function isRemovedExpertTeamId(value: string | null | undefined): boolean {
  return Boolean(value?.trim().toLowerCase().startsWith(REMOVED_EXPERT_TEAM_PREFIX));
}

/** Legacy persisted team ids degrade to no expert. New write APIs should use assertSingleExpertId instead. */
export function normalizeSingleExpertId(value: string | null | undefined): string | undefined {
  const id = value?.trim();
  if (!id || isRemovedExpertTeamId(id)) return undefined;
  return id;
}

/** Rejects the removed Expert Team namespace on new API/write paths while preserving normal Expert ids. */
export function assertSingleExpertId(value: string | null | undefined): string | undefined {
  const id = value?.trim();
  if (!id) return undefined;
  if (isRemovedExpertTeamId(id)) throw new Error("Expert teams are no longer supported；仅支持单专家");
  return id;
}
