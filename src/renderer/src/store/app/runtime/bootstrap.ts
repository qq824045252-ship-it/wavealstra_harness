import type { SpaceDto, TaskDto } from "../../../../../shared/agent-ipc";
import type { ModelInfoDto } from "../../../../../shared/agent-ipc";
import { normalizeCodeTheme } from "../../../../../shared/code-theme";
import {
  applyFontSettings,
  DEFAULT_CODE_FONT_SIZE,
  ensureAllUserFontsLoaded,
  legacyFontScaleToUiFontSize,
  normalizeCodeFontSize,
  normalizeUiFontSize,
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
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  if (typeof raf === "function") raf(() => raf(callback));
  else queueMicrotask(callback);
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
  // Critical: without spaces, tasks, models and settings the first screen has nothing to show.
  // Catalogs load afterwards, each with its own failure boundary.
  const critical = await Promise.all([
    api.db?.listSpaces() ?? Promise.resolve([]),
    api.db?.listTasks() ?? Promise.resolve([]),
    api.db?.listProjects?.() ?? Promise.resolve([]),
    api.db?.getSoul() ?? Promise.resolve(null),
    api.agent.listModels(),
    api.agent.getAppSettings?.() ?? Promise.resolve(null),
  ]).catch((error: unknown) => {
    if (isActive())
      console.warn("[initRuntime] failed to load required data from main", error);
    return null;
  });
  if (!critical) return;
  const [spaces, taskRows, projects, soul, models, appSettings] = critical;
  // A disposed runtime must never replace the state populated by its successor.
  if (!isActive()) return;
const mappedModels = mapModelCatalog(models);
const enabledModels = mappedModels.filter(
  (model) => model.enabled !== false,
);
// The same id set feeds every row; rebuilding it per task allocated one Set per task.
const enabledModelIds = new Set(enabledModels.map((model) => model.id));
const defaultModelId =
  appSettings?.defaultModelId &&
  enabledModels.some((model) => model.id === appSettings.defaultModelId)
    ? appSettings.defaultModelId
    : (enabledModels[0]?.id ?? "");

const mappedSpaces = helpers.recomputeEffectiveArchived(
  (spaces as SpaceDto[]).map((space) => ({
    id: space.id,
    name: space.name,
    path: space.path,
    archived: space.archived,
    pathMissing: space.pathMissing,
    parentId: space.parentId ?? null,
    sortOrder: space.sortOrder ?? 0,
    createdAt: space.createdAt,
    effectiveArchived: space.effectiveArchived ?? Boolean(space.archived),
  })),
);
const mappedTasks = (taskRows as TaskDto[]).map((row) =>
  helpers.mapTaskRowToTask(row, {
    enabledModelIds,
    defaultModelId,
    permissionModeDefault: appSettings?.permissionMode ?? "default",
    taskConnectorIds: appSettings?.taskConnectorIds,
  }),
);
set({
  spaces: mappedSpaces,
  projects,
  tasks: mappedTasks,
  pinnedTaskIds: mappedTasks
    .filter((task) => task.isFavorited)
    .map((task) => task.id),
  soul: soul ?? helpers.emptySoul,
  models: mappedModels,
  activeModelId: defaultModelId,
  defaultModelId,
  modelPreferences: appSettings?.modelPreferences ?? {},
  contextWindowTokens:
    mappedModels.find((model) => model.id === defaultModelId)
      ?.contextWindow || 128_000,
  permissionMode: appSettings?.permissionMode ?? "default",
  conversationBranchEnabled:
    appSettings?.conversationBranchEnabled === true,
  activeTaskId: null,
  panelOpen: false,
  artifactTabs: [],
  activeArtifactId: null,
});
markStartup("bootstrapApplied");
  // Two frames is the earliest proxy for "the task list can be clicked". The window is visible
  // during measurement, so this observes a real frame; renderer-loaded alone is never interactive.
// hint only; renderer-loaded alone is never reported as interactive.
afterInteractiveFrame(() => markStartup("taskListInteractive"));

  if (appSettings) {
    // UI and code typography retain their independent migration and application rules.
    const typography = {
      uiFontSize: normalizeUiFontSize(
        appSettings.uiFontSize ??
          legacyFontScaleToUiFontSize(appSettings.fontSize),
      ),
      codeFontSize: normalizeCodeFontSize(
        appSettings.codeFontSize ?? DEFAULT_CODE_FONT_SIZE,
      ),
      uiFontFamily: appSettings.uiFontFamily ?? appSettings.fontFamily ?? "",
      codeFontFamily: appSettings.codeFontFamily ?? "",
    };
    applyFontSettings(typography);
    document.documentElement.dataset.codeTheme = normalizeCodeTheme(
      appSettings.codeTheme,
    );
    try {
      const fonts = (await api.agent?.listUserFonts?.()) ?? [];
      await ensureAllUserFontsLoaded(fonts);
      if (isActive()) applyFontSettings(typography);
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
