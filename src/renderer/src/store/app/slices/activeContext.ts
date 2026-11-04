import type { ConversationBranchInfoDto } from "../../../../../shared/conversation-branch";
import { defaultModePresetId } from "../../../../../shared/mode-profile";
import type { PermissionMode, WelcomeMode } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import type { StreamingSendMode, TaskDraft } from "../types";

export interface ActiveContextState {
  activeTaskId: string | null;
  draft: TaskDraft | null;
  branchCreatingTaskId: string | null;
  branchSource: ConversationBranchInfoDto | null | undefined;
  branchChildren: ConversationBranchInfoDto[];
  branchError: { taskId: string; message: string } | null;
  activeModelId: string;
  modelExplicit: boolean;
  permissionMode: PermissionMode;
  permissionExplicit: boolean;
  activeConnectorIds: string[];
  fullAccessDuringRun: boolean;
  streamingSendMode: StreamingSendMode;
  homeSpaceId: string | null;
  welcomeMode: WelcomeMode;
  modePresetId: string | null;
  contextUsedTokens: number | null;
  contextEstimated: boolean;
  contextWindowTokens: number;
  contextCacheHitRate: number | null;
  contextInputTokens: number | null;
  contextCacheReadTokens: number | null;
  contextOutputTokens: number | null;
}

export function createActiveContextState(): ActiveContextState {
  return {
    activeTaskId: null,
    draft: null,
    branchCreatingTaskId: null,
    branchSource: undefined,
    branchChildren: [],
    branchError: null,
    activeModelId: "",
    modelExplicit: false,
    permissionMode: "default",
    permissionExplicit: false,
    activeConnectorIds: [],
    fullAccessDuringRun: false,
    streamingSendMode: "steer",
    homeSpaceId: null,
    welcomeMode: "working",
    modePresetId: defaultModePresetId("working"),
    contextUsedTokens: null,
    contextEstimated: false,
    contextWindowTokens: 128_000,
    contextCacheHitRate: null,
    contextInputTokens: null,
    contextCacheReadTokens: null,
    contextOutputTokens: null,
  };
}

export function createActiveContextActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "clearBranchError"
  | "setStreamingSendMode"
  | "setFullAccessDuringRun"
  | "setHomeSpaceId"
> {
  const { get, set } = storeContext;
  return {
    clearBranchError: () => {
      if (get().branchError) set({ branchError: null });
    },

    setStreamingSendMode: (mode) => {
      set({ streamingSendMode: mode });
    },

    setFullAccessDuringRun: (on) =>
      set({
        fullAccessDuringRun: on,
        permissionMode: on ? "auto" : "default",
      }),

    setHomeSpaceId: (id) => set({ homeSpaceId: id }),
  };
}
