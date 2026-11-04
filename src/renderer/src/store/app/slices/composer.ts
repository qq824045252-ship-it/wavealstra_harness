import type { ExternalAgentId } from "../../../../../shared/external-agent";
import { EMPTY_SELECTION } from "../../../../../shared/selection";
import type { SelectionState } from "../../../../../shared/selection";
import type { TerminalContextDto } from "../../../../../shared/terminal-ipc";
import type { RefFileItem } from "../../../lib/refTaskArtifacts";
import type { RefTaskItem } from "../../../lib/taskReference";
import type { ChatSelection } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export interface ComposerState {
  selection: SelectionState;
  chatSelections: ChatSelection[];
  terminalContext: TerminalContextDto | null;
  pendingRefFile: RefFileItem | null;
  pendingRefTask: RefTaskItem | null;
  pendingExternalAgentContinuation: {
    taskId: string;
    runId: string;
    agentId: ExternalAgentId;
    agentName: string;
  } | null;
  chatFocusTick: number;
  composerDraft: string | null;
  composerInsertion: string | null;
  selectMode: boolean;
  selectedMessageIds: string[];
}

export function createComposerState(): ComposerState {
  return {
    selection: { ...EMPTY_SELECTION },
    chatSelections: [],
    terminalContext: null,
    pendingRefFile: null,
    pendingRefTask: null,
    pendingExternalAgentContinuation: null,
    chatFocusTick: 0,
    composerDraft: null,
    composerInsertion: null,
    selectMode: false,
    selectedMessageIds: [],
  };
}

export function createComposerActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "clearChatSelection"
  | "clearTerminalContext"
  | "clearPendingRefFile"
  | "clearPendingRefTask"
  | "clearPendingExternalAgentContinuation"
  | "clearComposerDraft"
  | "clearComposerInsertion"
  | "setSelectMode"
  | "toggleMessageSelected"
  | "selectAllMessages"
> {
  const { get, set } = storeContext;
  return {
    clearChatSelection: (selection) => {
      if (!selection) {
        if (get().chatSelections.length) set({ chatSelections: [] });
        return;
      }
      set((s) => ({
        chatSelections: s.chatSelections.filter(
          (item) =>
            !(
              item.artifactId === selection.artifactId &&
              item.artifactVersion === selection.artifactVersion &&
              item.surfaceGeneration === selection.surfaceGeneration &&
              item.backendNodeId === selection.backendNodeId
            ),
        ),
      }));
    },

    clearTerminalContext: () => {
      if (get().terminalContext) set({ terminalContext: null });
    },

    clearPendingRefFile: () => {
      if (get().pendingRefFile) set({ pendingRefFile: null });
    },

    clearPendingRefTask: () => {
      if (get().pendingRefTask) set({ pendingRefTask: null });
    },

    clearPendingExternalAgentContinuation: () => {
      if (get().pendingExternalAgentContinuation)
        set({ pendingExternalAgentContinuation: null });
    },

    clearComposerDraft: () => {
      if (get().composerDraft != null) set({ composerDraft: null });
    },

    clearComposerInsertion: () => {
      if (get().composerInsertion != null) set({ composerInsertion: null });
    },

    setSelectMode: (on) => set({ selectMode: on, selectedMessageIds: [] }),

    toggleMessageSelected: (id) => {
      set((s) => ({
        selectedMessageIds: s.selectedMessageIds.includes(id)
          ? s.selectedMessageIds.filter((x) => x !== id)
          : [...s.selectedMessageIds, id],
      }));
    },

    selectAllMessages: (ids) => set({ selectedMessageIds: ids }),
  };
}
