import { useEffect } from "react";
import type { Artifact, Task } from "../../types";
import type { AppState, TerminalSurface, TerminalTabItem } from "./types";
import { currentTerminalOwnerKey } from "./selectors";
import { appSelectors, useAppStore } from "./store";

export function useActiveTask(): Task | null {
  return useAppStore(
    (s) => s.tasks.find((x) => x.id === s.activeTaskId) ?? null,
  );
}

/** Preserve the existing home/draft/active-task space lookup contracts. */
export function useHomeSpaceId(): string | null {
  return useAppStore((s) => s.homeSpaceId);
}

export function useDraftSpaceId(): string | null | undefined {
  return useAppStore((s) => s.draft?.spaceId ?? null);
}

export function useActiveTaskSpaceId(): string | null | undefined {
  return useAppStore(
    (s) => s.tasks.find((x) => x.id === s.activeTaskId)?.spaceId ?? null,
  );
}

export function getActiveTaskSpaceId(): string | null | undefined {
  const s = useAppStore.getState();
  return s.tasks.find((x) => x.id === s.activeTaskId)?.spaceId ?? null;
}

export function getDraftSpaceId(): string | null | undefined {
  return useAppStore.getState().draft?.spaceId ?? null;
}

export function getHomeSpaceId(): string | null {
  return useAppStore.getState().homeSpaceId;
}

/** Sidebar summaries retain identity while streaming message bodies grow. */
export function useSidebarTasks(): Task[] {
  return useAppStore(appSelectors.selectSidebarTasks);
}

/** Compatibility readers share the same selector instance as the React hooks. */
export function selectActiveTaskArtifacts(state: AppState): Artifact[] {
  return appSelectors.selectActiveTaskArtifacts(state);
}

export function selectVisibleActiveTaskArtifacts(state: AppState): Artifact[] {
  return appSelectors.selectVisibleActiveTaskArtifacts(state);
}

export function useActiveTaskArtifacts(): Artifact[] {
  return useAppStore(selectActiveTaskArtifacts);
}

/** Filter only artifact panels/chips; changes views keep the complete projection. */
export function useVisibleTaskArtifacts(): Artifact[] {
  const mode = useAppStore(
    (s) =>
      s.tasks.find((t) => t.id === s.activeTaskId)?.welcomeMode ??
      s.welcomeMode,
  );
  const refreshArtifactPolicy = useAppStore((s) => s.refreshArtifactPolicy);
  useEffect(() => {
    if (mode) void refreshArtifactPolicy(mode);
  }, [mode, refreshArtifactPolicy]);
  return useAppStore(selectVisibleActiveTaskArtifacts);
}

const EMPTY_TERMINAL_TABS_RECORD: {
  tabs: TerminalTabItem[];
  activeId: string | null;
} = {
  tabs: [],
  activeId: null,
};

export function useActiveTerminalTabs(surface: TerminalSurface = "panel"): {
  tabs: TerminalTabItem[];
  activeId: string | null;
} {
  return useAppStore((s) => {
    const ownerKey = currentTerminalOwnerKey(s, surface);
    return s.terminalTabsByOwner[ownerKey] ?? EMPTY_TERMINAL_TABS_RECORD;
  });
}
