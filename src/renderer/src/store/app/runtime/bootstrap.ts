import { DOTS_TASK_ID } from "../../../../../shared/dots";
import { resolveDotsPreferences } from "../../../../../shared/dots-settings";
import { readTaskHistory } from "./taskHistoryRead";
import type { SpaceDto, TaskDto } from "../../../../../shared/agent-ipc";
import type { ModelInfoDto } from "../../../../../shared/agent-ipc";
import { normalizeCodeTheme } from "../../../../../shared/code-theme";
import { getInitialAppearance } from "../../../lib/theme";
import {
  applyFontSettings,
  ensureAllUserFontsLoaded,
  resolveFontSettings,
} from "../../../lib/fontSettings";
import type {
  ModelConfig,
  PermissionMode,
  Soul,
  Space,
  Task,
  ThinkingLevel,
} from "../../../types";
import type { AppContext } from "../context";
import type { RuntimeBinding } from "./binding";

export interface BootstrapHelpers {
  mapTaskRowToTask(
    row: TaskDto,
    context: {
      enabledModelIds: ReadonlySet<string>;
      defaultModelId: string;
      permissionModeDefault: PermissionMode;
      taskConnectorIds?: Record<string, string[]>;
    },
  ): Task;
  recomputeEffectiveArchived(spaces: Space[]): Space[];
  emptySoul: Soul;
}

/** One mapper for both first paint and late discovery so a catalog refresh cannot change shapes. */
export function mapModelCatalog(models: ModelInfoDto[]): ModelConfig[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    supportsToolCall: model.supportsToolCall,
    supportsImages: model.supportsImages,
    supportsReasoning: model.supportsReasoning,
    enabled: model.enabled !== false,
    available: model.available,
    contextWindow: model.contextWindow,
    api: model.api,
    thinkingLevels: model.thinkingLevels as ThinkingLevel[] | undefined,
    metadata: model.metadata,
  }));
}

/**
 * Remote discovery finishes after the window is up. Refresh the catalog without replacing a
 * selection the user already made: only a missing default (or no selection at all) falls back.
 */
export async function reloadModelCatalog(context: AppContext): Promise<void> {
  const models = mapModelCatalog((await context.getApi()?.agent?.listModels?.()) ?? []);
  if (!models.length) return;
  const enabled = models.filter((model) => model.enabled !== false);
  context.set((state) => {
    const ids = new Set(models.map((model) => model.id));
    const fallback = enabled[0]?.id ?? models[0]!.id;
    return {
      models,
      defaultModelId:
        state.defaultModelId && ids.has(state.defaultModelId)
          ? state.defaultModelId
          : fallback,
      activeModelId: state.activeModelId || fallback,
    };
  });
}

/** Measurement marks must never affect startup: the bridge may be absent in tests. */
function markStartup(name: string): void {
  try {
    (
      globalThis as { window?: { api?: { perf?: { mark?: (name: string) => void } } } }
    ).window?.api?.perf?.mark?.(name);
  } catch {
    /* measurement only */
  }
}

function afterInteractiveFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(callback));
  } else {
    queueMicrotask(callback);
  }
}

export async function loadRuntimeBootstrap(
  binding: RuntimeBinding,
  helpers: BootstrapHelpers,
): Promise<void> {
  const {
    api,
    context: { set },
    isActive,
  } = binding;
  // The model catalog uses the Pi host. The task list uses the independently available database.
  const catalogBeforeRead = binding.context.get().models;
  const pendingModels = Promise.resolve().then(() => api.agent.listModels()).then(mapModelCatalog).catch(error => {
    if (isActive()) console.warn("[initRuntime] models failed to load", error);
    return undefined;
  });
  const critical = await Promise.all([
    api.db?.listSpaces() ?? Promise.resolve([]),
    api.db?.listTasks() ?? Promise.resolve([]),
    api.db?.listProjects?.() ?? Promise.resolve([]),
    api.db?.getSoul() ?? Promise.resolve(null),
    api.agent.getAppSettings?.() ?? Promise.resolve(null),
  ]).catch((error: unknown) => {
    if (isActive())
      console.warn("[initRuntime] failed to load required data from main", error);
    return null;
  });
  if (!critical) return;
  const [spaces, taskRows, projects, soul, appSettings] = critical;
  // A disposed runtime must never replace the state populated by its successor.
  if (!isActive()) return;
  const current = binding.context.get();
  const configuredDefaultModelId = appSettings?.defaultModelId ?? "";
  const cachedModels = current.models ?? [];
  const initialModels = cachedModels.filter(model => model.enabled !== false);
  const initialModelIds = new Set(initialModels.map(model => model.id));
  const initialDefaultModelId = initialModelIds.has(configuredDefaultModelId)
    ? configuredDefaultModelId : (initialModels[0]?.id ?? "");
  if (cachedModels.length === 0) {
    // An unavailable catalog has not validated or invalidated any stored task selection yet.
    for (const row of taskRows) if (row.modelId) initialModelIds.add(row.modelId);
  }

  const mappedSpaces = helpers.recomputeEffectiveArchived(
    (spaces as SpaceDto[]).map((space) => ({
      id: space.id,
      name: space.name,
      icon: space.icon,
      path: space.path,
      archived: space.archived,
      pathMissing: space.pathMissing,
      parentId: space.parentId ?? null,
      sortOrder: space.sortOrder ?? 0,
      createdAt: space.createdAt,
      effectiveArchived: space.effectiveArchived ?? Boolean(space.archived),
    })),
  );
  const priorTasks = new Map(current.tasks.map(task => [task.id, task]));
  const mappedTasks = taskRows.map(row => {
    const metadata = helpers.mapTaskRowToTask(row, {
      enabledModelIds: initialModelIds,
      defaultModelId: initialDefaultModelId,
      permissionModeDefault: appSettings?.permissionMode ?? "default",
      taskConnectorIds: appSettings?.taskConnectorIds,
    });
    const prior = priorTasks.get(row.id);
    return prior ? { ...prior, ...metadata, messages: prior.messages, status: prior.durable ? prior.status : metadata.status } : metadata;
  });
  const dots = priorTasks.get(DOTS_TASK_ID);
  if (dots && !mappedTasks.some(task => task.id === DOTS_TASK_ID)) mappedTasks.push(dots);
  const selected = mappedTasks.find(task => task.id === current.activeTaskId);
  const initialActiveModelId = selected ? current.activeModelId : initialDefaultModelId;
  set({
    spaces: mappedSpaces,
    projects,
    tasks: mappedTasks,
    pinnedTaskIds: mappedTasks.filter(task => task.isFavorited).map(task => task.id),
    soul: soul ?? helpers.emptySoul,
    activeModelId: initialActiveModelId,
    dotsModelId: resolveDotsPreferences(appSettings?.dotsSettings).modelId,
    dotsFollowModelId: configuredDefaultModelId,
    defaultModelId: initialDefaultModelId,
    modelPreferences: appSettings?.modelPreferences ?? {},
    contextWindowTokens: selected ? current.contextWindowTokens :
      initialModels.find(model => model.id === initialDefaultModelId)?.contextWindow || 128_000,
    permissionMode: selected ? current.permissionMode : appSettings?.permissionMode ?? "default",
    conversationBranchEnabled: appSettings?.conversationBranchEnabled === true,
    ...(!selected ? {
      activeTaskId: null, notificationMessageTarget: undefined, panelOpen: false, artifactTabs: [], activeArtifactId: null,
    } : {}),
  });
  if (selected?.durable) {
    // Rebinding can miss the last delta even if no further event arrives.
    void readTaskHistory(binding.context, selected.id).catch(error => {
      if (isActive()) set(state => ({ tasks: state.tasks.map(task => task.id === selected.id
        ? { ...task, historyError: String(error) } : task) }));
    });
  }
  markStartup("bootstrapApplied");
  // Measure two actual frames after the task list state was applied.
  afterInteractiveFrame(() => {
    if (isActive()) markStartup("taskListInteractive");
  });

  const restoreModels = pendingModels.then(loadedModels => {
    if (!loadedModels || !isActive()) return;
    const persistedModels = new Map(taskRows.map(task => [task.id, task.modelId]));
    const initialTaskModels = new Map(mappedTasks.map(task => [task.id, task.modelId]));
    set(state => {
      const models = state.models === catalogBeforeRead ? loadedModels : (state.models ?? loadedModels);
      const enabled = models.filter(model => model.enabled !== false);
      const enabledIds = new Set(enabled.map(model => model.id));
      const preferred = state.defaultModelId === initialDefaultModelId ? configuredDefaultModelId : state.defaultModelId;
      const defaultModelId = enabledIds.has(preferred) ? preferred : (enabled[0]?.id ?? "");
      const tasks = state.tasks.map(task => {
        const persisted = persistedModels.get(task.id);
        if (!persistedModels.has(task.id) || task.modelId !== initialTaskModels.get(task.id)) return task;
        const modelId = persisted && enabledIds.has(persisted) ? persisted : defaultModelId;
        return task.modelId === modelId ? task : { ...task, modelId };
      });
      const followedDefault = state.activeTaskId === null && state.activeModelId === initialActiveModelId;
      const activeModelId = followedDefault ? defaultModelId :
        state.activeModelId || tasks.find(task => task.id === state.activeTaskId)?.modelId || defaultModelId;
      return {
        models, tasks, defaultModelId, activeModelId,
        contextWindowTokens: followedDefault || !state.activeModelId
          ? models.find(model => model.id === activeModelId)?.contextWindow ?? state.contextWindowTokens
          : state.contextWindowTokens,
      };
    });
  });

  if (appSettings) {
    binding.context.get().setDesktopAppearance(appSettings.desktopAppearance ?? getInitialAppearance(appSettings.theme));
    applyFontSettings(resolveFontSettings(appSettings));
    document.documentElement.dataset.codeTheme = normalizeCodeTheme(
      appSettings.codeTheme,
    );
    try {
      const fonts = (await api.agent?.listUserFonts?.()) ?? [];
      await ensureAllUserFontsLoaded(fonts);
      if (isActive() && fonts.length) applyFontSettings({});
    } catch (error) {
      if (isActive())
        console.warn("[initRuntime] load user fonts failed", error);
    }
  }

  // Optional catalogs. Each read owns its failure: one slow or broken directory must neither
  // delay the first screen nor erase the data already applied above.
  const loadOptional = async (
    label: string,
    read: () => Promise<void>,
  ): Promise<void> => {
    try {
      await read();
    } catch (error) {
      if (isActive())
        console.warn(
          `[initRuntime] ${label} failed to load; remaining data stays available`,
          error,
        );
    }
  };
  await Promise.all([
    restoreModels,
    loadOptional("skills", async () => {
      const rows = await api.agent.listSkills();
      if (!isActive()) return;
      set({
        skills: rows.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          author: skill.author,
          icon: skill.icon,
          installed: skill.installed,
          enabled: skill.enabled,
          builtin: skill.builtin,
          command: skill.command,
          filePath: skill.filePath,
          source: skill.source,
        })),
      });
    }),
    loadOptional("market skills", async () => {
      const rows = (await api.agent.listMarketSkills?.()) ?? [];
      if (!isActive()) return;
      set({
        marketSkills: rows.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          author: skill.author,
          icon: skill.icon,
          installed: false,
          enabled: false,
          command: skill.name,
          version: skill.version,
          source: skill.source,
        })),
      });
    }),
    loadOptional("experts", async () => {
      const rows = (await api.agent.listExperts?.()) ?? [];
      if (!isActive()) return;
      set({ experts: rows.map((expert) => ({ ...expert, installed: true })) });
    }),
    loadOptional("market experts", async () => {
      const rows = (await api.agent.listMarketExperts?.()) ?? [];
      if (!isActive()) return;
      set({
        marketExperts: rows.map((expert) => ({
          ...expert,
          installed: false,
          enabled: false,
        })),
      });
    }),
    loadOptional("connectors", async () => {
      const rows = (await api.agent.listConnectors?.()) ?? [];
      if (!isActive()) return;
      set({ connectors: rows });
    }),
  ]);
}
