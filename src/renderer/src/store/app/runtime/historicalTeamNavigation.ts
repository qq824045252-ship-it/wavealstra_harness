import type { AppState } from "../types";

/** Runtime-only viewer: it never becomes a composer selection or a team identity. */
export function guardHistoricalTeamNavigation(state: AppState, patch: Partial<AppState>): Partial<AppState> {
  const changed = ("page" in patch && patch.page !== state.page)
    || ("activeBotId" in patch && patch.activeBotId !== state.activeBotId)
    || ("activeTeam" in patch && patch.activeTeam?.templateId !== state.activeTeam?.templateId);
  return changed ? { ...patch, historicalTeamWork: null,
    botNavigationEpoch: patch.botNavigationEpoch ?? state.botNavigationEpoch + 1 } : patch;
}
