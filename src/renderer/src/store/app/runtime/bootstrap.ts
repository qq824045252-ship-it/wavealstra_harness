import type { SpaceDto, TaskDto } from "../../../../../shared/agent-ipc";
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
  PermissionMode,
  Soul,
  Space,
  Task,
  ThinkingLevel,
} from "../../../types";
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

export async function loadRuntimeBootstrap(
  binding: RuntimeBinding,
  helpers: BootstrapHelpers,
): Promise<void> {
  const {
    api,
    context: { set },
    isActive,
  } = binding;
  try {
    const [
      spaces,
      taskRows,
      projects,
      soul,
      models,
      skillRows,
      marketRows,
      appSettings,
      expertRows,
      marketExpertRows,
      connectorRows,
    ] = await Promise.all([
      api.db?.listSpaces() ?? Promise.resolve([]),
      api.db?.listTasks() ?? Promise.resolve([]),
      api.db?.listProjects?.() ?? Promise.resolve([]),
      api.db?.getSoul() ?? Promise.resolve(null),
      api.agent.listModels(),
      api.agent.listSkills(),
      api.agent.listMarketSkills?.() ?? Promise.resolve([]),
      api.agent.getAppSettings?.() ?? Promise.resolve(null),
      api.agent.listExperts?.() ?? Promise.resolve([]),
      api.agent.listMarketExperts?.() ?? Promise.resolve([]),
      api.agent.listConnectors?.() ?? Promise.resolve([]),
    ]);
    // A disposed runtime must never replace the state populated by its successor.
    if (!isActive()) return;

    const mappedModels = models.map((model) => ({
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
    const enabledModels = mappedModels.filter(
      (model) => model.enabled !== false,
    );
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
        enabledModelIds: new Set(enabledModels.map((model) => model.id)),
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
      skills: skillRows.map((skill) => ({
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
      marketSkills: marketRows.map((skill) => ({
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
      experts: expertRows.map((expert) => ({ ...expert, installed: true })),
      marketExperts: marketExpertRows.map((expert) => ({
        ...expert,
        installed: false,
        enabled: false,
      })),
      connectors: connectorRows ?? [],
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

    if (!isActive() || !appSettings) return;
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
      if (!isActive()) return;
      await ensureAllUserFontsLoaded(fonts);
      if (isActive()) applyFontSettings(typography);
    } catch (error) {
      if (isActive())
        console.warn("[initRuntime] load user fonts failed", error);
    }
  } catch (error) {
    if (isActive())
      console.warn("[initRuntime] failed to load from main", error);
  }
}
