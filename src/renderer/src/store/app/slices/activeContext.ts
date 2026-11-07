import { createBotConversationActions, createBotConversationState, type BotConversationUiState } from "./botConversation";
import { mergeWorkList, reconcileWorkProjection } from "./botWorkSync";
import type { WorkListCursor } from "../../../../../shared/bot-conversation";
import type { ConversationBranchInfoDto } from "../../../../../shared/conversation-branch";
import type { BotDto, WorkProjectionDto } from "../../../../../shared/bot-work";
import type { BotWorkHostStatusDto } from "../../../../../shared/bot-work-ipc";
import { defaultModePresetId } from "../../../../../shared/mode-profile";
import type { PermissionMode, WelcomeMode } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import type { StreamingSendMode, TaskDraft } from "../types";

export interface ActiveContextState {
  botDrafts: BotConversationUiState["botDrafts"];
  botHistories: BotConversationUiState["botHistories"];
  botPendingSends: BotConversationUiState["botPendingSends"];
  botConversationErrors: BotConversationUiState["botConversationErrors"];
  botWorkCursor: WorkListCursor | null;
  activeTaskId: string | null;
  activeBotId: string | null;
  selectedWorkId: string | null;
  botDraft: string;
  botSubmissionNotice: boolean;
  botIdentities: BotDto[];
  botIdentitiesLoaded: boolean;
  botWorks: WorkProjectionDto[];
  botHostStatus: BotWorkHostStatusDto | null;
  botWorkError: string | null;
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
    ...createBotConversationState(),
    botWorkCursor: null,
    activeTaskId: null,
    activeBotId: null,
    selectedWorkId: null,
    botDraft: "",
    botSubmissionNotice: false,
    botIdentities: [],
    botIdentitiesLoaded: false,
    botWorks: [],
    botHostStatus: null,
    botWorkError: null,
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
  | "setBotDraft"
  | "submitBotDraft"
  | "refreshBotHistory"
  | "cancelBotSend"
  | "archiveBotConversation"
  | "setActiveBotId"
  | "setSelectedWorkId"
  | "refreshBotWork"
  | "applyWorkProjection"
  | "markBotNotificationRead"
> {
  const { get, set, getApi } = storeContext;
  let refreshSequence = 0;
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

    ...createBotConversationActions(storeContext),
    setSelectedWorkId: (workId) => set({ selectedWorkId: workId }),
    refreshBotWork: async (includeClosed = false) => {
      const api = getApi();
      const requestSequence = ++refreshSequence;
      const scope = includeClosed ? "all" : "open";
      const cursor = get().botWorkCursor?.scope === scope ? get().botWorkCursor ?? undefined : undefined;
      try {
        const apiBot = api?.botWork;
        if (!apiBot) throw new Error("Work 主机离线，当前投影待同步");
        const [bots, initial, hostStatus] = await Promise.all([
          apiBot.listBots(), apiBot.syncWorks({ includeClosed, cursor }), apiBot.hostStatus(),
        ]);
        let update = initial;
        let merged = mergeWorkList(get().botWorks, cursor ?? null, update);
        while (merged && update.kind === "delta" && update.hasMore && requestSequence === refreshSequence) {
          update = await apiBot.syncWorks({ includeClosed, cursor: merged.cursor });
          merged = mergeWorkList(merged.works, merged.cursor, update);
        }
        if (requestSequence !== refreshSequence) return;
        // Retention or an epoch change can invalidate any page, not only the first.
        if (!merged) {
          update = await apiBot.syncWorks({ includeClosed });
          merged = mergeWorkList(get().botWorks, null, update);
        }
        if (!merged) throw new Error("列表水位缺口，等待全量同步");
        const botWorks = merged.works;
        const botWorkCursor = merged.cursor;
        if (requestSequence !== refreshSequence) return;
        set((state) => {
          const activeBotId = bots.some(bot => bot.botId === state.activeBotId) ? state.activeBotId : bots[0]?.botId ?? null;
          const observed = new Map(state.botWorks.map(work => [work.workId, work]));
          return {
            botIdentities: bots,
            botWorks: botWorks.map(work => reconcileWorkProjection(work, observed.get(work.workId))),
            botWorkCursor,
            botHostStatus: hostStatus,
            botIdentitiesLoaded: true,
            botWorkError: null,
            botDraft: activeBotId === state.activeBotId ? state.botDraft : state.botDrafts[activeBotId ?? ""] ?? "",
            activeBotId,
            selectedWorkId: botWorks.some((work) => work.workId === state.selectedWorkId)
              ? state.selectedWorkId
              : null,
          };
        });
      } catch (error) {
        if (requestSequence !== refreshSequence) return;
        set({
          botIdentitiesLoaded: true,
          botWorkError: error instanceof Error ? error.message : String(error),
        });
      }
    },
    applyWorkProjection: () => {
      // Unsequenced push only wakes the durable list reader; it cannot resurrect a tombstone.
      void get().refreshBotWork(get().botWorkCursor?.scope === "all");
    },
    markBotNotificationRead: async (notificationId) => {
      const api = getApi();
      const result = await api?.botWork?.markNotificationRead(notificationId);
      if (result?.ok) {
        set((state) => ({
          botWorks: state.botWorks.map((work) => ({
            ...work,
            notifications: work.notifications.map((notification) =>
              notification.notificationId === notificationId
                ? { ...notification, readAt: notification.readAt ?? Date.now() }
                : notification),
          })),
        }));
      }
    },

    setHomeSpaceId: (id) => set({ homeSpaceId: id }),
  };
}
