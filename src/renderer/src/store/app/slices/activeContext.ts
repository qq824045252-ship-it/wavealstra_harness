import { botParticipatesInWork } from "@/lib/botWorkspacePresentation";
import { createBotConversationActions, createBotConversationState, type BotConversationUiState } from "./botConversation";
import { mergeWorkList } from "./botWorkSync";
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
  | "createBot"
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
    createBot: async request => {
      const api = getApi()?.botWork;
      if (!api?.createBot) throw new Error("当前应用尚未连接创建接口，请重新启动最新版应用后重试。");
      const result = await api.createBot(request);
      if (result.ok) {
        if (!result.bot?.botId || result.bot.displayName !== request.displayName.trim()
          || result.bot.responsibilitySummary !== (request.responsibilitySummary ?? "").trim()) {
          throw new Error("创建回执与原请求不匹配，请按原请求重试核对。");
        }
        // A list request started before this committed creation cannot remove its
        // identity or roll back a newer selection when it eventually resolves.
        refreshSequence += 1;
        set(state => ({ botIdentitiesLoaded: true,
          botIdentities: [...state.botIdentities.filter(bot => bot.botId !== result.bot.botId), result.bot] }));
      }
      return result;
    },
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
          const restored = storeContext.runtime.botNavigation.restore(bots, botWorks);
          const previousBot = state.botIdentities.find(bot => bot.botId === state.activeBotId);
          const requestedId = restored.activeBotId ?? state.activeBotId;
          // Restoration eligibility is stricter than read-only browsing: a
          // paused/disabled Bot must remain inspectable when explicitly opened.
          const activeBot = bots.find(bot => bot.botId === requestedId
            && (!previousBot || bot.botId !== previousBot.botId || bot.userId === previousBot.userId));
          const activeBotId = activeBot?.botId ?? bots[0]?.botId ?? null;
          const invalidatedBot = requestedId !== null && !activeBot;
          const selectedWorkId = "selectedWorkId" in restored ? restored.selectedWorkId : state.selectedWorkId;
          return {
            ...restored,
            ...(invalidatedBot && state.page === "bot" ? { page: "chat" as const } : {}),
            botIdentities: bots,
            botWorks,
            botWorkCursor,
            botHostStatus: hostStatus,
            botIdentitiesLoaded: true,
            botWorkError: null,
            botDraft: activeBotId === state.activeBotId ? state.botDraft : state.botDrafts[activeBotId ?? ""] ?? "",
            activeBotId,
            selectedWorkId: !invalidatedBot && botWorks.some((work) => work.workId === selectedWorkId && botParticipatesInWork(work, activeBotId)
              && (includeClosed || work.lifecycle !== "closed"))
              ? selectedWorkId ?? null
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
