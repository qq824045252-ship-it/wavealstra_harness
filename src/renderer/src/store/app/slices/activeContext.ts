import type { ConversationBranchInfoDto } from "../../../../../shared/conversation-branch";
import type { BotDto, WorkProjectionDto } from "../../../../../shared/bot-work";
import type { BotWorkHostStatusDto } from "../../../../../shared/bot-work-ipc";
import { defaultModePresetId } from "../../../../../shared/mode-profile";
import type { PermissionMode, WelcomeMode } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import type { StreamingSendMode, TaskDraft } from "../types";

function reconcileWorkProjection(incoming: WorkProjectionDto, observed?: WorkProjectionDto): WorkProjectionDto {
  if (!observed) return incoming;
  if (observed.stateVersion > incoming.stateVersion) return observed;
  // A read acknowledgement is monotonic but does not advance the control version.
  const readAtById = new Map(observed.notifications.map(item => [item.notificationId, item.readAt]));
  return {
    ...incoming,
    notifications: incoming.notifications.map(item => {
      const readAt = readAtById.get(item.notificationId);
      return item.readAt === undefined && readAt !== undefined ? { ...item, readAt } : item;
    }),
  };
}

export interface ActiveContextState {
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

    setBotDraft: (text) => set({ botDraft: text, botSubmissionNotice: false }),
    submitBotDraft: () => {
      if (get().botDraft.trim()) set({ botSubmissionNotice: true });
    },
    setActiveBotId: (botId) => set({ activeBotId: botId, selectedWorkId: null }),
    setSelectedWorkId: (workId) => set({ selectedWorkId: workId }),
    refreshBotWork: async (includeClosed = false) => {
      const api = getApi();
      const requestSequence = ++refreshSequence;
      const requestedVersions = new Map(get().botWorks.map(work => [work.workId, work.stateVersion]));
      try {
        const [bots, works, hostStatus] = await Promise.all([
          api?.botWork?.listBots() ?? Promise.resolve([]),
          api?.botWork?.listWorks(includeClosed) ?? Promise.resolve([]),
          api?.botWork?.hostStatus() ?? Promise.resolve(null),
        ]);
        if (requestSequence !== refreshSequence) return;
        set((state) => {
          const observedById = new Map(state.botWorks.map(work => [work.workId, work]));
          const incomingIds = new Set(works.map(work => work.workId));
          const botWorks = [
            ...works.map(work => reconcileWorkProjection(work, observedById.get(work.workId))),
            // An open-only response removes stale cards for Works closed offline.
            // Preserve only facts that arrived after this request began.
            ...state.botWorks.filter(observed => !incomingIds.has(observed.workId)
              && (requestedVersions.get(observed.workId) ?? -1) < observed.stateVersion),
          ];
          return {
            botIdentities: bots,
            botWorks,
            botHostStatus: hostStatus,
            botIdentitiesLoaded: true,
            botWorkError: null,
            activeBotId: bots.some((bot) => bot.botId === state.activeBotId)
              ? state.activeBotId
              : bots[0]?.botId ?? null,
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
    applyWorkProjection: (projection) => {
      set((state) => {
        const existing = state.botWorks.find((work) => work.workId === projection.workId);
        if (existing && existing.stateVersion >= projection.stateVersion) return {};
        const botWorks = existing
          ? state.botWorks.map((work) => (work.workId === projection.workId ? reconcileWorkProjection(projection, work) : work))
          : [projection, ...state.botWorks];
        return { botWorks };
      });
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
