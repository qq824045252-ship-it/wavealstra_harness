import { normalizeSingleExpertId } from "../../../../../shared/expert-id";
import {
  DEFAULT_WELCOME_MODE,
  defaultModePresetId,
} from "../../../../../shared/mode-profile";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export function createTaskDraftActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  "startProjectTask" | "newTask" | "summonExpert" | "setDraftProject"
> {
  const { get, set } = storeContext;
  return {
    startProjectTask: ({
      projectId,
      planId,
      spaceId,
      title,
      welcomeMode,
      modePresetId,
    }) => {
      const trimmed = title?.trim();
      set({
        draft: {
          projectId,
          planId,
          spaceId,
          title: trimmed || undefined,
        },
        activeTaskId: null,
        chatSelections: [],
        pendingExternalAgentContinuation: null,
        activeConnectorIds: [],
        modelExplicit: false,
        permissionExplicit: false,
        homeSpaceId: spaceId ?? null,
        welcomeMode,
        modePresetId: modePresetId ?? defaultModePresetId(welcomeMode),
        page: "chat",
        panelOpen: false,
        artifactTabs: [],
        activeArtifactId: null,
        selectMode: false,
        selectedMessageIds: [],
      });
    },

    newTask: (spaceId, projectId) => {
      // 只登记草稿、不建任务：首条消息发出时才 materialize 并落库，
      // 避免每次点击都产生一条空白「新任务」行。
      set({
        activeModelId: get().defaultModelId,
        contextWindowTokens:
          get().models.find((model) => model.id === get().defaultModelId)
            ?.contextWindow ?? 128_000,
        draft:
          spaceId !== undefined || projectId !== undefined
            ? { spaceId, projectId }
            : null,
        // A fresh task uses the product default, not the previous task's code scene.
        welcomeMode: DEFAULT_WELCOME_MODE,
        modePresetId: defaultModePresetId(DEFAULT_WELCOME_MODE),
        activeTaskId: null,
        chatSelections: [],
        // 新任务从零开始：不继承上一任务的 Active 连接器（安装 ≠ active）
        activeConnectorIds: [],
        // F2：新任务不继承任何显式选择（默认跟随 Tag/Mode 建议）
        modelExplicit: false,
        permissionExplicit: false,
        // 顶层「新建任务」必须回到普通任务；从空间内新建时则只保留该空间。
        // 否则 sendMessage 会把上一次首页选择的 homeSpaceId 当成兜底重新绑定。
        homeSpaceId: spaceId ?? null,
        page: "chat",
        panelOpen: false,
        artifactTabs: [],
        activeArtifactId: null,
        selectMode: false,
        selectedMessageIds: [],
      });
      void get().refreshModelConfiguration();
    },

    summonExpert: (expertId, spaceId) => {
      if (!normalizeSingleExpertId(expertId)) return;
      // 只登记草稿、不建任务：首条消息发出时才 materialize 并落库，
      // 避免每次都产生一条空白「新任务」行。
      set({
        draft: { spaceId, expertId },
        activeTaskId: null,
        chatSelections: [],
        homeSpaceId: spaceId ?? null,
        page: "chat",
        panelOpen: false,
        artifactTabs: [],
        activeArtifactId: null,
        selectMode: false,
        selectedMessageIds: [],
        // F4：召唤新专家任务不继承上一任务的 Active 连接器（与 newTask/createRelatedTask 一致）
        activeConnectorIds: [],
        // F2：新任务不继承显式模型/权限标记
        modelExplicit: false,
        permissionExplicit: false,
      });
    },

    setDraftProject: (projectId) => {
      if (get().activeTaskId) return;
      set((state) => ({
        draft: projectId
          ? { ...(state.draft ?? {}), projectId }
          : state.draft
            ? { ...state.draft, projectId: undefined }
            : null,
      }));
    },
  };
}
