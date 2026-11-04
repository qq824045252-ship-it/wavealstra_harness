import { isGatewayBotTaskId } from "../../../../../shared/gateway-task";
import {
  defaultModePresetId,
  resolveEffectiveModePolicy,
  resolveModePreset,
} from "../../../../../shared/mode-profile";
import type { PermissionMode } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export function createSessionConfigurationActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "setWelcomeMode"
  | "setModePreset"
  | "refreshModelConfiguration"
  | "setActiveConnectors"
  | "setActiveModel"
  | "followSuggestedModel"
  | "followSuggestedPermission"
  | "setPermissionMode"
> {
  const { get, set } = storeContext;
  return {
    setWelcomeMode: (mode) => {
      const taskId = get().activeTaskId;
      const task = taskId
        ? get().tasks.find((item) => item.id === taskId)
        : undefined;
      // A submitted Bot already owns its backend before its first history snapshot arrives.
      const locked = Boolean(
        task &&
          (task.messages.length > 0 ||
            task.sessionFile ||
            task.botPendingSubmission ||
            task.durable),
      );
      if (locked) {
        // 全局 selection 必须对新模式合法（不能把 design preset 带到 coding）
        set({ welcomeMode: mode, modePresetId: defaultModePresetId(mode) });
        return;
      }
      // 目标模式 preset：重选当前模式保留 selection；跨模式切换用该模式默认（集中式，保证合法）
      const sameMode = mode === get().welcomeMode;
      const preset =
        sameMode && get().modePresetId != null
          ? get().modePresetId
          : defaultModePresetId(mode);
      set((s) => ({
        welcomeMode: mode,
        modePresetId: preset,
        tasks: taskId
          ? s.tasks.map((t) =>
              t.id === taskId
                ? { ...t, welcomeMode: mode, modePresetId: preset }
                : t,
            )
          : s.tasks,
      }));
      // 产物面板显示过滤用：切换模式后立即拉取新模式的产物黑白名单（失败静默，兜底在消费侧）
      void get().refreshArtifactPolicy(mode);
      if (task) {
        void storeContext.getApi()?.db?.upsertTask({
          id: task.id,
          title: task.title,
          updatedAt: Date.now(),
          welcomeMode: mode,
          modePresetId: preset,
        });
      }
    },

    setModePreset: (presetId) => {
      const taskId = get().activeTaskId;
      if (isGatewayBotTaskId(taskId)) return;
      const task = taskId
        ? get().tasks.find((item) => item.id === taskId)
        : undefined;
      // 通知主进程：Tag/preset 被选择 → 立即触发 required-runtime prewarm（不等发送消息）
      void storeContext
        .getApi()
        ?.agent?.selectModePreset?.({
          welcomeMode: get().welcomeMode,
          modePresetId: presetId,
        })
        .catch(() => undefined);
      // Bot Tags configure the next Durable input; other modes retain their session lock.
      const locked =
        task?.welcomeMode !== "bot" &&
        Boolean(task && (task.messages.length > 0 || task.sessionFile));
      if (locked) {
        set({ modePresetId: presetId });
        return;
      }
      set((s) => ({
        modePresetId: presetId,
        tasks: taskId
          ? s.tasks.map((t) =>
              t.id === taskId ? { ...t, modePresetId: presetId } : t,
            )
          : s.tasks,
      }));
      if (task) {
        void storeContext.getApi()?.db?.upsertTask({
          id: task.id,
          title: task.title,
          updatedAt: Date.now(),
          modePresetId: presetId,
        });
      }
    },

    refreshModelConfiguration: async () => {
      const api = storeContext.getApi()?.agent;
      if (!api) return;
      try {
        const models = await api.listModels();
        const settings = await api.getAppSettings();
        set((s) => {
          const enabled = models.filter(
            (model) => model.enabled !== false && model.available !== false,
          );
          const defaultModelId =
            enabled.find((model) => model.id === settings.defaultModelId)?.id ??
            enabled[0]?.id ??
            "";
          // A task and an explicit draft selection belong to the user. External defaults
          // only select a model for an unmaterialized, unpinned draft.
          const activeModelId =
            !s.activeTaskId && !s.modelExplicit
              ? defaultModelId
              : s.activeModelId;
          return {
            models,
            defaultModelId,
            activeModelId,
            modelPreferences: settings.modelPreferences ?? {},
            contextWindowTokens:
              models.find((model) => model.id === activeModelId)
                ?.contextWindow ?? s.contextWindowTokens,
          };
        });
      } catch (error) {
        console.warn(
          "[models] External configuration refresh failed; keeping current selection",
          error,
        );
      }
    },

    setActiveConnectors: (ids) => {
      const taskId = get().activeTaskId;
      const next = [
        ...new Set(ids.map((x) => String(x).trim()).filter(Boolean)),
      ];
      set((s) => ({
        activeConnectorIds: next,
        tasks: taskId
          ? s.tasks.map((t) =>
              t.id === taskId ? { ...t, connectorIds: next } : t,
            )
          : s.tasks,
      }));
      // F3：任务级 Active 连接器持久化（settings.json，无新 DB schema）；重启后恢复
      if (taskId)
        void storeContext.getApi()?.agent?.setTaskConnectorIds?.(taskId, next);
    },

    setActiveModel: (id) => {
      const model = get().models.find(
        (m) => m.id === id && m.enabled !== false,
      );
      if (!model) return;
      const taskId = get().activeTaskId;
      set((s) => ({
        activeModelId: id,
        defaultModelId: id,
        // F2：显式选择只在当前任务内生效（任务级标记，不跨任务泄漏）
        modelExplicit: true,
        contextWindowTokens: model?.contextWindow || get().contextWindowTokens,
        tasks: taskId
          ? s.tasks.map((task) =>
              task.id === taskId
                ? { ...task, modelId: id, modelExplicit: true }
                : task,
            )
          : s.tasks,
      }));
      // 模型选择仍更新默认模型，但 reasoning preference 按 modelId 独立持久化。
      void storeContext.getApi()?.agent?.updateAppSettings?.({
        defaultModelId: id,
      });
      const task = taskId
        ? get().tasks.find((item) => item.id === taskId)
        : undefined;
      if (task && (task.messages.length > 0 || task.sessionFile)) {
        void storeContext.getApi()?.db?.upsertTask({
          id: task.id,
          title: task.title,
          updatedAt: Date.now(),
          modelId: id,
        });
      }
    },

    followSuggestedModel: async () => {
      const { activeTaskId, welcomeMode, modePresetId } = get();
      const task = activeTaskId
        ? get().tasks.find((t) => t.id === activeTaskId)
        : undefined;
      let resolved: string | null = null;
      try {
        const profile = await storeContext
          .getApi()
          ?.agent?.getModeProfile?.(task?.welcomeMode ?? welcomeMode);
        const preset = profile
          ? resolveModePreset(
              profile.policy,
              task?.modePresetId ?? modePresetId ?? null,
            )
          : undefined;
        const effective = profile
          ? resolveEffectiveModePolicy(profile.policy, preset)
          : null;
        const suggested = effective?.suggestedModelId ?? null;
        if (
          suggested &&
          get().models.some((m) => m.id === suggested && m.enabled !== false)
        )
          resolved = suggested;
      } catch {
        /* 仅清标记；主进程回落默认 */
      }
      const targetId = resolved ?? get().activeModelId;
      const model = get().models.find((m) => m.id === targetId);
      set((s) => ({
        modelExplicit: false,
        activeModelId: targetId,
        contextWindowTokens: model?.contextWindow || s.contextWindowTokens,
        tasks: activeTaskId
          ? s.tasks.map((t) =>
              t.id === activeTaskId
                ? { ...t, modelExplicit: false, modelId: resolved ?? t.modelId }
                : t,
            )
          : s.tasks,
      }));
      if (resolved && activeTaskId) {
        const t = get().tasks.find((x) => x.id === activeTaskId);
        if (t && (t.messages.length > 0 || t.sessionFile)) {
          void storeContext.getApi()?.db?.upsertTask?.({
            id: t.id,
            title: t.title,
            updatedAt: Date.now(),
            modelId: resolved,
          });
        }
      }
    },

    followSuggestedPermission: async () => {
      const { activeTaskId, welcomeMode, modePresetId } = get();
      const task = activeTaskId
        ? get().tasks.find((t) => t.id === activeTaskId)
        : undefined;
      let next: PermissionMode = get().permissionMode;
      try {
        const profile = await storeContext
          .getApi()
          ?.agent?.getModeProfile?.(task?.welcomeMode ?? welcomeMode);
        const preset = profile
          ? resolveModePreset(
              profile.policy,
              task?.modePresetId ?? modePresetId ?? null,
            )
          : undefined;
        const effective = profile
          ? resolveEffectiveModePolicy(profile.policy, preset)
          : null;
        const suggested = effective?.suggestedPermissionMode ?? null;
        if (suggested) next = suggested;
      } catch {
        /* 仅清标记 */
      }
      set((s) => ({
        permissionExplicit: false,
        permissionMode: next,
        fullAccessDuringRun: next === "auto",
        tasks: activeTaskId
          ? s.tasks.map((t) =>
              t.id === activeTaskId
                ? { ...t, permissionExplicit: false, permissionMode: next }
                : t,
            )
          : s.tasks,
      }));
      if (activeTaskId) {
        const t = get().tasks.find((x) => x.id === activeTaskId);
        if (t && (t.messages.length > 0 || t.sessionFile)) {
          void storeContext.getApi()?.db?.upsertTask?.({
            id: t.id,
            title: t.title,
            updatedAt: Date.now(),
            permissionMode: next,
          });
          // 已有会话立即应用（等价于显式切换；后续消息因标记已清不再发送 explicit）
          void storeContext
            .getApi()
            ?.agent?.setPermissionMode?.({
              taskId: activeTaskId,
              permissionMode: next,
            });
        }
      }
    },

    setPermissionMode: (mode) => {
      const taskId = get().activeTaskId;
      set((s) => ({
        permissionMode: mode,
        // F2：显式选择（含显式选 default）只在当前任务内生效（任务级标记）
        permissionExplicit: true,
        fullAccessDuringRun: mode === "auto",
        tasks: taskId
          ? s.tasks.map((task) =>
              task.id === taskId
                ? { ...task, permissionMode: mode, permissionExplicit: true }
                : task,
            )
          : s.tasks,
      }));
      void storeContext
        .getApi()
        ?.agent?.updateAppSettings?.({ permissionMode: mode });
      if (taskId) {
        const task = get().tasks.find((item) => item.id === taskId);
        if (task && (task.messages.length > 0 || task.sessionFile)) {
          void storeContext.getApi()?.db?.upsertTask({
            id: task.id,
            title: task.title,
            updatedAt: Date.now(),
            permissionMode: mode,
          });
        }
        void storeContext.getApi()?.agent?.setPermissionMode?.({
          taskId,
          permissionMode: mode,
        });
      }
    },
  };
}
