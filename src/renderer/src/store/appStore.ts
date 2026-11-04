/** Stable public entry point. State, operations and runtime have one implementation in app/. */
export { useAppStore } from "./app/store";
export {
  useActiveTask,
  useHomeSpaceId,
  useDraftSpaceId,
  useActiveTaskSpaceId,
  getActiveTaskSpaceId,
  getDraftSpaceId,
  getHomeSpaceId,
  useSidebarTasks,
  useActiveTaskArtifacts,
  useVisibleTaskArtifacts,
  useActiveTerminalTabs,
  selectActiveTaskArtifacts,
  selectVisibleActiveTaskArtifacts,
} from "./app/hooks";
export { currentTerminalOwnerKey } from "./app/selectors";
export {
  hydrateExternalAgentHistory,
  applySelectionMirror,
} from "./app/compat";
export {
  upsertTextBlock,
  freezeFinalTextSegment,
  appendErrorBlock,
  nonEmptyFinalTextBlocks,
  applyPatchToMessage,
} from "./app/messages/messageReducer";
export { historyMessageToChatMessage } from "./app/messages/historyMapper";
export { relativeTime, clockTime, sizeLabel } from "./app/format";
export type {
  Theme,
  PanelMode,
  StreamingSendMode,
  SettingsTab,
  TaskDraft,
  PendingRegeneration,
  CreateRelatedTaskOptions,
  TerminalTabItem,
  RelocateSpaceResult,
} from "./app/types";
