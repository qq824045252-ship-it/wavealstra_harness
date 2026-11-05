import type { TaskModelRecommendations } from "@shared/task-model-recommendations";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { ModelInfoDto, ModelsFileConfigDto, ModelsProviderConfigDto, SubagentConfigDto } from "@shared/agent-ipc";
import { BUILTIN_CODEX_IMAGE_MODEL, BUILTIN_CODEX_IMAGE_PROVIDER_ID } from "@shared/builtin-capabilities";
import {
  reasoningEffortLabel,
  reasoningPreferenceSummary,
} from "@shared/model-metadata";
import { IconPencil, IconPlus, IconRefresh, IconSearch, IconTrash } from "@/components/common/icons";
import {
  modelOptionLabel,
  resolveSubagentReasoningAfterModelSwitch,
  targetSubagentModel,
  validateSubagentReasoningPreference,
} from "@shared/subagent-model-config";
import ModelEditorModal from "./models/ModelEditorModal";
import SubagentExecutionSettings from "./SubagentExecutionSettings";
import ProviderAuthSection from "./models/ProviderAuthSection";
import {
  API_OPTIONS,
  emptyDraft,
  modelLimitLabel,
  modelSourceLabel,
  type LoginProviderInfo,
  type ModelListItem,
  type SavedModelEntry,
} from "./models/types";

interface ProviderDraft {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  userAgent: string;
}

interface ProviderView {
  id: string;
  name: string;
  enabled: boolean;
  login: LoginProviderInfo | null;
  config: ModelsProviderConfigDto | null;
  models: ModelListItem[];
  customOnly: boolean;
}

const PROTOCOL_OPTIONS = [
  { id: "openai-completions", label: "OpenAI 兼容" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic" },
  { id: "google-generative-ai", label: "Gemini" },
] as const;

function flattenSavedModels(cfg: ModelsFileConfigDto | null | undefined): SavedModelEntry[] {
  const out: SavedModelEntry[] = [];
  for (const [providerId, provider] of Object.entries(cfg?.providers ?? {})) {
    for (const model of provider.models ?? []) {
      if (!model.id?.trim()) continue;
      out.push({
        providerId,
        baseUrl: provider.baseUrl || "",
        api: provider.api || "openai-completions",
        modelId: model.id,
        name: model.name ?? model.id,
        contextWindow: model.contextWindow ?? 0,
        reasoning: model.reasoning ?? false,
        imageInput: model.input?.includes("image") ?? false,
        definition: model,
        override: provider.modelOverrides?.[model.id],
        allowOff: false,
        thinkingKeys: [],
      });
    }
  }
  return out;
}

function providerDraftFrom(view: ProviderView): ProviderDraft {
  const cfg = view.config;
  const api = cfg?.api || view.models[0]?.api || "openai-completions";
  const headers = cfg?.headers ?? {};
  return {
    id: view.id,
    name: cfg?.name?.trim() || view.name || view.id,
    api,
    baseUrl: cfg?.baseUrl || view.login?.baseUrl || "",
    userAgent: headers["User-Agent"] || headers["user-agent"] || view.login?.userAgent || "",
  };
}

function newProviderDraft(): ProviderDraft {
  return {
    id: "custom-provider",
    name: "",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    userAgent: "",
  };
}

function slugifyProvider(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "custom-provider";
}

function apiLabel(api?: string): string {
  return PROTOCOL_OPTIONS.find((item) => item.id === api)?.label
    ?? API_OPTIONS.find((item) => item.id === api)?.label
    ?? api
    ?? "自动";
}

function reasoningControlSummary(model: ModelListItem): string {
  if (model.metadata?.reasoningControl === "unknown") return "思考能力未公布";
  if (!model.supportsReasoning) return "";
  return model.thinkingLevels?.length ? `思考 ${model.thinkingLevels.map((level) => reasoningEffortLabel(level, model.metadata)).join(" / ")}` : "思考：由模型控制";
}

export default function ModelsTab(): React.JSX.Element {
  const activeModelId = useAppStore((state) => state.activeModelId);
  const setActiveModel = useAppStore((state) => state.setActiveModel);
  const modelPreferences = useAppStore((state) => state.modelPreferences);

  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [modelsConfig, setModelsConfig] = useState<ModelsFileConfigDto>({ providers: {} });
  const saved = useMemo(() => flattenSavedModels(modelsConfig), [modelsConfig]);
  const [loginProviders, setLoginProviders] = useState<LoginProviderInfo[]>([]);
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(newProviderDraft());
  const [providerDirty, setProviderDirty] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelInfoDto[]>([]);
  const [pausedProviderModels, setPausedProviderModels] = useState<Record<string, string[]>>({});
  const [defaultModelId, setDefaultModelId] = useState("");
  const [taskRecommendations, setTaskRecommendations] = useState<TaskModelRecommendations>({});
  const [subagentConfig, setSubagentConfig] = useState<SubagentConfigDto | null>(null);
  const [usageSaving, setUsageSaving] = useState(false);
  const detailRef = useRef<HTMLElement | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"add" | "edit">("add");
  const [editingEntry, setEditingEntry] = useState<SavedModelEntry | null>(null);

  const refreshLoginProviders = async (): Promise<LoginProviderInfo[]> => {
    const list = (await window.api?.agent?.listLoginProviders?.()) ?? [];
    setLoginProviders(list);
    return list;
  };

  const refreshSaved = async (): Promise<void> => {
    const cfg = (await window.api?.agent?.getModelsConfig?.()) ?? { providers: {} };
    setModelsConfig(cfg);
  };

  const refreshUsageAssignments = async (): Promise<void> => {
    const [settings, subagent, catalog] = await Promise.all([
      window.api?.agent?.getAppSettings?.(),
      window.api?.agent?.getSubagentConfig?.(),
      window.api?.agent?.listModels?.(),
    ]);
    setDefaultModelId(settings?.defaultModelId ?? "");
    setTaskRecommendations(settings?.taskModelRecommendations ?? {});
    setPausedProviderModels(settings?.pausedProviderModels ?? {});
    setSubagentConfig(subagent ?? null);
    setModelCatalog(catalog ?? []);
    useAppStore.setState({ modelPreferences: settings?.modelPreferences ?? {} });
  };

  const applyModels = (list: ModelListItem[], preferredId?: string): void => {
    const normalized = list.map((model) => ({ ...model, enabled: model.enabled !== false }));
    const enabled = normalized.filter((model) => model.enabled !== false && model.available !== false);
    const nextId = enabled.find((model) => model.id === activeModelId)?.id
      ?? enabled.find((model) => model.id === preferredId)?.id
      ?? enabled[0]?.id
      ?? activeModelId
      ?? "";
    const nextModel = normalized.find((model) => model.id === nextId);
    useAppStore.setState({
      models: normalized,
      activeModelId: nextId,
      contextWindowTokens: nextModel?.contextWindow || enabled.find((model) => (model.contextWindow ?? 0) > 0)?.contextWindow || 0,
    });
  };

  const mapModelList = (list: ModelListItem[]): ModelListItem[] => list.map((model) => ({ ...model }));

  const reloadModels = async (): Promise<void> => {
    setBusy(true);
    setHint("");
    try {
      const providerId = selectedProviderId;
      const result = await window.api?.agent?.reloadModels?.(providerId || undefined);
      const list = result?.models ?? [];
      setModelCatalog(list);
      applyModels(mapModelList(list));
      const [refreshedProviders] = await Promise.all([refreshLoginProviders(), refreshSaved()]);
      if (providerId) {
        const refreshedProvider = refreshedProviders.find((provider) => provider.id === providerId);
        const providerModels = refreshedProvider?.models ?? list.filter((model) => model.vendor === providerId);
        const providerName = refreshedProvider?.name || providerId;
        const providerError = result?.errors.find((error) => error.providerId === providerId);
        if (providerError) {
          setHint(`${providerName} 模型目录更新失败，已保留现有目录：${providerError.message}`);
        } else if (!result?.requestedProviderIds?.includes(providerId)) {
          setHint(refreshedProvider?.loggedIn
            ? `${providerName} 没有可拉取的上游模型目录；已按本地配置重新加载。模型列表由它的写入方维护，手改 models.json 的 models 段会被覆盖。`
            : `${providerName} 尚未配置凭证；Pi 只能读取本地配置，无法刷新模型目录。`);
        } else {
          const otherFailures = result?.errors.length ?? 0;
          const providerSuffix = otherFailures > 0 ? `；另有 ${otherFailures} 个 Provider 更新失败` : "";
          const suffix = providerSuffix;
          setHint(providerModels.length
            ? `Pi 已更新 ${providerName}：${providerModels.length} 个模型${suffix}`
            : `Pi 已更新 ${providerName}：当前没有模型${suffix}`);
        }
      } else {
        const failures = result?.errors.length ?? 0;
        const requested = result?.requestedProviderIds?.length ?? 0;
        setHint(requested === 0
          ? "没有可拉取上游目录的 Provider；已按本地 models.json 重新加载"
          : failures > 0
          ? `上游刷新完成，${failures} 个 Provider 失败；已保留其本地模型`
          : (list.length ? `已从上游刷新全部 Provider：${list.length} 个可用模型` : "已从上游刷新，当前没有可用模型"));
      }
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const refresh = (): void => {
      void Promise.all([refreshLoginProviders(), refreshSaved(), refreshUsageAssignments()])
        .catch((error) => setHint(error instanceof Error ? error.message : String(error)));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const selectableModels = useMemo(
    () => modelCatalog.filter((model) =>
      model.kind !== "image-generation"
      && model.available !== false
      && model.enabled !== false,
    ),
    [modelCatalog],
  );
  const selectableModelIds = useMemo(() => new Set(selectableModels.map((model) => model.id)), [selectableModels]);
  const subagentTargetModel = useMemo(
    () => targetSubagentModel(
      selectableModels,
      subagentConfig?.defaultModel,
      defaultModelId,
    ),
    [selectableModels, subagentConfig?.defaultModel, defaultModelId],
  );
  const subagentThinkingLevels = subagentTargetModel?.thinkingLevels ?? [];
  const defaultModelInvalid = Boolean(defaultModelId && !selectableModelIds.has(defaultModelId));
  const subagentModelInvalid = Boolean(
    subagentConfig?.defaultModel && !selectableModelIds.has(subagentConfig.defaultModel),
  );

  const saveGlobalDefaultModel = async (modelId: string): Promise<void> => {
    if (!selectableModelIds.has(modelId)) {
      setHint("只能把已认证、已启用且当前可用的聊天模型设为全局默认");
      return;
    }
    setUsageSaving(true);
    setHint("");
    try {
      const next = await window.api?.agent?.updateAppSettings?.({ defaultModelId: modelId });
      const savedId = next?.defaultModelId ?? modelId;
      setDefaultModelId(savedId);
      const currentSubagent = await window.api?.agent?.getSubagentConfig?.();
      if (currentSubagent) setSubagentConfig(currentSubagent);
      if (currentSubagent && !currentSubagent.defaultModel && currentSubagent.defaultReasoning) {
        try {
          const refreshed = await window.api?.agent?.saveSubagentConfig?.({ expectedRevision: currentSubagent.revision });
          if (refreshed) setSubagentConfig(refreshed);
        } catch (error) {
          setHint(`Main default saved. Subagent reasoning could not be refreshed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
      setHint("主对话默认模型已更新；当前任务模型不会被强制切换");
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setUsageSaving(false);
    }
  };

  const saveSubagentDefaults = async (
    patch: Pick<SubagentConfigDto, "defaultModel" | "defaultReasoning">,
  ): Promise<void> => {
    if (!subagentConfig) return;
    const merged: SubagentConfigDto = {
      ...subagentConfig,
      ...patch,
      globalDefaultModelId: defaultModelId || undefined,
    };
    const validation = validateSubagentReasoningPreference({
      defaultModel: merged.defaultModel,
      preference: merged.defaultReasoning,
      models: selectableModels,
      globalDefaultModelId: defaultModelId,
    });
    merged.defaultReasoning = validation.preference;
    setUsageSaving(true);
    setHint("");
    try {
      const next = await window.api?.agent?.saveSubagentConfig?.({ defaultModel: merged.defaultModel, defaultReasoning: merged.defaultReasoning, expectedRevision: subagentConfig.revision });
      if (next) setSubagentConfig(next);
      setHint(validation.problems.length
        ? validation.problems.join("；")
        : "Subagent 模型策略已更新");
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setUsageSaving(false);
    }
  };

  const changeSubagentModel = async (modelId: string): Promise<void> => {
    if (!subagentConfig) return;
    const nextModel = modelId || undefined;
    const resolved = resolveSubagentReasoningAfterModelSwitch({
      previous: subagentConfig.defaultReasoning,
      newModelId: nextModel,
      models: selectableModels,
      globalDefaultModelId: defaultModelId,
    });
    await saveSubagentDefaults({
      defaultModel: nextModel,
      defaultReasoning: resolved.preference,
    });
    if (resolved.problem) setHint(resolved.problem);
  };

  const reconcileAssignmentsAfterCatalog = async (catalog: ModelInfoDto[]): Promise<void> => {
    const candidates = catalog.filter((model) =>
      model.kind !== "image-generation"
      && model.available !== false
      && model.enabled !== false,
    );
    const ids = new Set(candidates.map((model) => model.id));
    let nextDefault = defaultModelId;
    if (nextDefault && !ids.has(nextDefault)) {
      nextDefault = candidates[0]?.id ?? "";
      if (nextDefault) {
        const next = await window.api?.agent?.updateAppSettings?.({ defaultModelId: nextDefault });
        nextDefault = next?.defaultModelId ?? nextDefault;
        setDefaultModelId(nextDefault);
      }
    }
    if (subagentConfig?.defaultModel && !ids.has(subagentConfig.defaultModel)) {
      const next = await window.api?.agent?.saveSubagentConfig?.({
        defaultModel: undefined,
        defaultReasoning: undefined,
        expectedRevision: subagentConfig.revision,
      });
      if (next) setSubagentConfig(next);
    }
  };

  const providers = useMemo<ProviderView[]>(() => {
    const map = new Map<string, ProviderView>();
    for (const provider of loginProviders) {
      map.set(provider.id, {
        id: provider.id,
        name: provider.name || provider.id,
        enabled: provider.loggedIn && !Object.prototype.hasOwnProperty.call(pausedProviderModels, provider.id),
        login: provider,
        config: modelsConfig.providers[provider.id] ?? null,
        models: [...(provider.models ?? [])],
        customOnly: false,
      });
    }
    for (const [id, config] of Object.entries(modelsConfig.providers)) {
      const current = map.get(id);
      if (current) {
        current.config = config;
        current.name = config.name?.trim() || current.name;
      } else {
        map.set(id, {
          id,
          name: config.name?.trim() || id,
          enabled: false,
          login: null,
          config,
          models: [],
          customOnly: true,
        });
      }
    }
    for (const model of modelCatalog) {
      const id = model.vendor;
      const current = map.get(id) ?? {
        id,
        name: id,
        enabled: false,
        login: null,
        config: modelsConfig.providers[id] ?? null,
        models: [],
        customOnly: false,
      };
      const index = current.models.findIndex((item) => item.id === model.id);
      if (index >= 0) current.models[index] = { ...current.models[index], ...model };
      else current.models.push(model);
      map.set(id, current);
    }
    return [...map.values()].sort((a, b) => {
      if (Boolean(a.login?.loggedIn) !== Boolean(b.login?.loggedIn)) return a.login?.loggedIn ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
  }, [loginProviders, modelsConfig.providers, modelCatalog, pausedProviderModels]);

  useEffect(() => {
    if (creatingProvider) return;
    if (selectedProviderId && providers.some((provider) => provider.id === selectedProviderId)) return;
    const preferred = providers.find((provider) => provider.enabled) ?? providers[0];
    setSelectedProviderId(preferred?.id ?? "");
  }, [providers, selectedProviderId, creatingProvider]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;

  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setModelFilter("");
  }, [selectedProviderId, creatingProvider]);

  useEffect(() => {
    if (creatingProvider || !selectedProvider) return;
    setProviderDraft(providerDraftFrom(selectedProvider));
    setProviderDirty(false);
  }, [selectedProviderId, selectedProvider?.config, selectedProvider?.login?.baseUrl, selectedProvider?.login?.userAgent, creatingProvider]);

  const filteredProviders = useMemo(() => {
    const query = providerFilter.trim().toLowerCase();
    if (!query) return providers;
    return providers.filter((provider) => provider.id.toLowerCase().includes(query) || provider.name.toLowerCase().includes(query));
  }, [providers, providerFilter]);
  const enabledProviders = filteredProviders.filter((provider) => provider.login?.loggedIn);
  const disabledProviders = filteredProviders.filter((provider) => !provider.login?.loggedIn);

  const toggleProviderEnabled = async (): Promise<void> => {
    if (busy || !selectedProvider) return;
    const provider = selectedProvider;
    setBusy(true);
    setHint("");
    try {
      const agent = window.api?.agent;
      if (!agent) throw new Error("模型设置服务不可用");
      const list = await agent.setProviderEnabled(provider.id, !provider.enabled);
      applyModels(mapModelList(list));
      await Promise.all([refreshLoginProviders(), refreshUsageAssignments()]);
      setHint(provider.enabled
        ? `${provider.name} 已关闭，已保留凭证和模型选择`
        : `${provider.name} 已开启，已恢复原有模型选择`);
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const patchProvider = (patch: Partial<ProviderDraft>): void => {
    setProviderDraft((current) => ({ ...current, ...patch }));
    setProviderDirty(true);
  };

  const saveProvider = async (): Promise<void> => {
    const id = providerDraft.id.trim();
    const name = providerDraft.name.trim();
    if (!id || !providerDraft.baseUrl.trim()) {
      setHint("请填写 Provider ID 与基础 URL");
      return;
    }
    if (creatingProvider && modelsConfig.providers[id]) {
      setHint(`Provider「${id}」已经存在`);
      return;
    }
    setBusy(true);
    setHint("");
    try {
      const providersNext = { ...modelsConfig.providers };
      const previous = providersNext[id] ?? selectedProvider?.config;
      const headers = { ...(previous?.headers ?? {}) };
      if (providerDraft.userAgent.trim()) headers["User-Agent"] = providerDraft.userAgent.trim();
      else {
        delete headers["User-Agent"];
        delete headers["user-agent"];
      }
      const config: ModelsProviderConfigDto = {
        ...previous,
        name: name || id,
        baseUrl: providerDraft.baseUrl.trim().replace(/\/$/, ""),
        api: providerDraft.api,
        headers: Object.keys(headers).length ? headers : undefined,
        models: previous?.models ?? [],
      };
      if (!creatingProvider && selectedProvider && selectedProvider.id !== id) delete providersNext[selectedProvider.id];
      providersNext[id] = config;
      const list = await window.api?.agent?.saveModelsConfig?.({ providers: providersNext });
      const effectiveList = list ?? [];
      setModelCatalog(effectiveList);
      applyModels(mapModelList(effectiveList));
      await Promise.all([refreshSaved(), refreshLoginProviders()]);
      setCreatingProvider(false);
      setSelectedProviderId(id);
      setProviderDirty(false);
      setHint("Provider 配置已保存；需要重新拉取官方模型时请点击「刷新模型」");
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteProviderConfig = async (): Promise<void> => {
    if (!selectedProvider?.config) return;
    const label = selectedProvider.customOnly ? "删除此自定义 Provider" : "删除此 Provider 的本地覆盖配置";
    if (!confirm(`${label}？`)) return;
    setBusy(true);
    try {
      const providersNext = { ...modelsConfig.providers };
      delete providersNext[selectedProvider.id];
      const list = await window.api?.agent?.saveModelsConfig?.({ providers: providersNext });
      setModelCatalog(list ?? []);
      applyModels(mapModelList(list ?? []));
      await Promise.all([refreshSaved(), refreshLoginProviders()]);
      setHint("本地 Provider 配置已删除");
    } finally {
      setBusy(false);
    }
  };

  const openAddProvider = (): void => {
    setCreatingProvider(true);
    setProviderDraft(newProviderDraft());
    setProviderDirty(false);
    setHint("");
  };

  const openAddModel = (): void => {
    const targetId = creatingProvider ? providerDraft.id.trim() : selectedProvider?.id;
    if (!targetId) {
      setHint("请先保存 Provider，再添加模型");
      return;
    }
    const targetConfig = modelsConfig.providers[targetId];
    const draft = emptyDraft();
    draft.providerId = targetId;
    draft.baseUrl = targetConfig?.baseUrl || providerDraft.baseUrl || selectedProvider?.login?.baseUrl || "";
    draft.api = targetConfig?.api || providerDraft.api || selectedProvider?.models[0]?.api || "openai-completions";
    setEditorMode("add");
    setEditingEntry(draft);
    setEditorOpen(true);
  };

  const openEditModel = (entry: SavedModelEntry): void => {
    const fullId = `${entry.providerId}/${entry.modelId}`;
    const runtime = modelCatalog.find((model) => model.id === fullId)
      ?? loginProviders.flatMap((provider) => provider.models ?? []).find((model) => model.id === fullId);
    setEditorMode("edit");
    setEditingEntry({
      ...entry,
      name: runtime?.name ?? entry.name,
      reasoning: runtime?.supportsReasoning ?? entry.reasoning,
      imageInput: runtime?.supportsImages ?? entry.imageInput,
      toolCall: runtime?.supportsToolCall ?? entry.toolCall,
      structuredOutput: runtime?.metadata?.structuredOutput ?? entry.structuredOutput,
      temperature: runtime?.metadata?.temperature ?? entry.temperature,
      contextWindow: runtime?.contextWindow ?? entry.contextWindow,
      metadata: runtime?.metadata ?? entry.metadata,
      thinkingKeys: runtime?.thinkingLevels ?? [],
      inputLimits: runtime?.inputLimits,
      reasoningPreference: modelPreferences[fullId]?.reasoning,
    });
    setEditorOpen(true);
  };

  const openModelDetails = (model: ModelListItem): void => {
    const savedEntry = savedByModelId.get(model.id);
    if (savedEntry) {
      openEditModel(savedEntry);
      return;
    }
    const providerId = model.vendor;
    const prefix = `${providerId}/`;
    const modelId = model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
    const draft = emptyDraft();
    draft.providerId = providerId;
    draft.modelId = modelId;
    draft.name = model.name;
    draft.baseUrl = modelsConfig.providers[providerId]?.baseUrl
      || loginProviders.find((provider) => provider.id === providerId)?.baseUrl
      || "";
    draft.api = model.api || modelsConfig.providers[providerId]?.api || "openai-completions";
    draft.contextWindow = model.contextWindow ?? 0;
    draft.reasoning = model.supportsReasoning;
    draft.imageInput = model.supportsImages;
    draft.toolCall = model.supportsToolCall;
    draft.structuredOutput = Boolean(model.metadata?.structuredOutput);
    draft.temperature = Boolean(model.metadata?.temperature);
    draft.metadata = model.metadata;
    draft.override = modelsConfig.providers[providerId]?.modelOverrides?.[modelId];
    draft.thinkingKeys = model.thinkingLevels ?? [];
    draft.inputLimits = model.inputLimits;
    draft.reasoningPreference = modelPreferences[model.id]?.reasoning;
    openEditModel(draft);
  };

  const persistModelConfig = async (draft: SavedModelEntry): Promise<ModelInfoDto[]> => {
    const providerId = draft.providerId.trim();
    const modelId = draft.modelId.trim();
    if (!providerId || !modelId) throw new Error("缺少 Provider 或模型 ID");

    const existing = (await window.api?.agent?.getModelsConfig?.()) ?? { providers: {} };
    const providersNext = { ...existing.providers };
    const previous = providersNext[providerId] ?? {
      name: selectedProvider?.name || providerId,
      baseUrl: draft.baseUrl,
      api: draft.api,
      models: [],
    };
    const modelsNext = [...(previous.models ?? [])];
    const index = modelsNext.findIndex((model) => model.id === modelId);
    if (editorMode === "add" && (index >= 0 || modelCatalog.some((model) => model.id === `${providerId}/${modelId}`))) {
      throw new Error("这个模型 ID 已存在，请直接编辑现有模型");
    }
    if (editorMode === "add" || draft.definition) {
      const definition = { ...draft.definition, id: modelId };
      if (index < 0) modelsNext.push(definition);
      else modelsNext[index] = definition;
    }
    const overrides = { ...previous.modelOverrides };
    if (draft.override && Object.keys(draft.override).length) overrides[modelId] = draft.override;
    else delete overrides[modelId];
    providersNext[providerId] = {
      ...previous,
      baseUrl: previous.baseUrl || draft.baseUrl.trim().replace(/\/$/, ""),
      api: previous.api || draft.api,
      models: modelsNext,
      modelOverrides: overrides,
    };

    return (await window.api?.agent?.saveModelsConfig?.({ providers: providersNext })) ?? [];
  };

  const saveModelDraft = async (draft: SavedModelEntry): Promise<void> => {
    const providerId = draft.providerId.trim();
    const modelId = draft.modelId.trim();
    if (!providerId || !modelId) throw new Error("缺少 Provider 或模型 ID");
    const preferenceModelId = `${providerId}/${modelId}`;
    const agent = window.api?.agent;
    if (!agent) throw new Error("模型设置服务不可用");
    setBusy(true);
    setHint("");
    try {
      const configChanged = editorMode === "add"
        || JSON.stringify(draft.definition) !== JSON.stringify(editingEntry?.definition)
        || JSON.stringify(draft.override) !== JSON.stringify(editingEntry?.override);
      if (configChanged) {
        const list = await persistModelConfig(draft);
        setModelCatalog(list);
        applyModels(mapModelList(list));
      }
      if (JSON.stringify(draft.reasoningPreference) !== JSON.stringify(editingEntry?.reasoningPreference)) {
        const settings = await agent.getAppSettings();
        const preferences = { ...settings.modelPreferences };
        if (draft.reasoningPreference) preferences[preferenceModelId] = { reasoning: draft.reasoningPreference };
        else delete preferences[preferenceModelId];
        const updated = await agent.updateAppSettings({ modelPreferences: preferences });
        useAppStore.setState({ modelPreferences: updated.modelPreferences ?? {} });
      }
      await Promise.all([refreshSaved(), refreshLoginProviders()]);
      setEditorOpen(false);
      setHint(configChanged ? "模型配置已保存到 models.json" : "思考偏好已保存到 Pi settings.json");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setHint(error.message);
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const toggleModelEnabled = async (modelId: string, nextEnabled: boolean, kind?: ModelListItem["kind"]): Promise<void> => {
    if (kind === "image-generation") {
      setBusy(true);
      setHint("");
      try {
        const current = await window.api?.agent?.getBuiltinCapabilities?.();
        if (!current) throw new Error("图像生成能力配置不可用");
        const savedCapabilities = await window.api?.agent?.saveBuiltinCapabilities?.({
          ...current.config,
          imageGeneration: {
            ...current.config.imageGeneration,
            enabled: nextEnabled,
            provider: BUILTIN_CODEX_IMAGE_PROVIDER_ID,
            model: BUILTIN_CODEX_IMAGE_MODEL,
          },
        });
        if (!savedCapabilities) throw new Error("图像生成能力保存失败");
        await refreshLoginProviders();
        setHint(nextEnabled ? "GPT Image 2 图像生成已启用" : "GPT Image 2 图像生成已关闭");
      } catch (err) {
        setHint(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (busy) return;
    if (!nextEnabled && selectableModelIds.has(modelId) && selectableModels.length <= 1) {
      setHint("至少保留一个可用模型");
      return;
    }
    setBusy(true);
    setHint("");
    try {
      const currentCatalog = (await window.api?.agent?.listModels?.()) ?? [];
      const enabled = new Set(
        currentCatalog
          .filter((model) => model.kind !== "image-generation" && model.enabled !== false)
          .map((model) => model.id),
      );
      if (nextEnabled) enabled.add(modelId);
      else enabled.delete(modelId);
      await window.api?.agent?.updateAppSettings?.({ enabledModels: [...enabled] });
      const list = (await window.api?.agent?.listModels?.()) ?? [];
      setModelCatalog(list);
      applyModels(mapModelList(list));
      await refreshLoginProviders();
      if (!nextEnabled) await reconcileAssignmentsAfterCatalog(list);
      setHint(nextEnabled ? "模型已启用" : "模型已关闭");
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const setVisibleModelsEnabled = async (models: ModelListItem[], nextEnabled: boolean): Promise<void> => {
    if (busy || models.length === 0) return;
    const chatModels = models.filter((model) => model.kind !== "image-generation");
    const imageModels = models.filter((model) => model.kind === "image-generation");
    if (!nextEnabled && chatModels.length > 0) {
      const targets = new Set(chatModels.map((model) => model.id));
      const enabledOutside = selectableModels.some((model) => !targets.has(model.id));
      if (!enabledOutside) {
        setHint("至少保留一个可用聊天模型；当前列表包含全部可用聊天模型");
        return;
      }
    }
    setBusy(true);
    setHint("");
    try {
      if (chatModels.length > 0) {
        const currentCatalog = (await window.api?.agent?.listModels?.()) ?? [];
        const enabled = new Set(
          currentCatalog
            .filter((model) => model.kind !== "image-generation" && model.enabled !== false)
            .map((model) => model.id),
        );
        for (const model of chatModels) {
          if (nextEnabled) enabled.add(model.id);
          else enabled.delete(model.id);
        }
        await window.api?.agent?.updateAppSettings?.({ enabledModels: [...enabled] });
      }
      if (imageModels.length > 0) {
        const current = await window.api?.agent?.getBuiltinCapabilities?.();
        if (!current) throw new Error("图像生成能力配置不可用");
        const savedCapabilities = await window.api?.agent?.saveBuiltinCapabilities?.({
          ...current.config,
          imageGeneration: {
            ...current.config.imageGeneration,
            enabled: nextEnabled,
            provider: BUILTIN_CODEX_IMAGE_PROVIDER_ID,
            model: BUILTIN_CODEX_IMAGE_MODEL,
          },
        });
        if (!savedCapabilities) throw new Error("图像生成能力保存失败");
      }
      const list = (await window.api?.agent?.listModels?.()) ?? [];
      setModelCatalog(list);
      applyModels(mapModelList(list));
      await refreshLoginProviders();
      if (!nextEnabled && chatModels.length > 0) await reconcileAssignmentsAfterCatalog(list);
      setHint(nextEnabled ? `已启用当前列表中的 ${models.length} 个模型` : `已关闭当前列表中的 ${models.length} 个模型`);
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const deleteModel = async (entry: SavedModelEntry): Promise<void> => {
    if (!confirm(`确定删除模型「${entry.name}」？`)) return;
    setBusy(true);
    try {
      const existing = (await window.api?.agent?.getModelsConfig?.()) ?? { providers: {} };
      const providersNext = { ...existing.providers };
      const previous = providersNext[entry.providerId];
      if (!previous) return;
      providersNext[entry.providerId] = { ...previous, models: (previous.models ?? []).filter((model) => model.id !== entry.modelId) };
      const list = await window.api?.agent?.saveModelsConfig?.({ providers: providersNext });
      setModelCatalog(list ?? []);
      applyModels(mapModelList(list ?? []));
      await Promise.all([refreshSaved(), refreshLoginProviders()]);
      await reconcileAssignmentsAfterCatalog(list ?? []);
      setHint(`已删除 ${entry.name}`);
    } finally {
      setBusy(false);
    }
  };

  const viewModels = creatingProvider ? [] : [...(selectedProvider?.models ?? [])]
    .sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false));
  const modelQuery = modelFilter.trim().toLowerCase();
  const filteredViewModels = modelQuery
    ? viewModels.filter((model) => model.name.toLowerCase().includes(modelQuery) || model.id.toLowerCase().includes(modelQuery))
    : viewModels;
  const allVisibleModelsEnabled = filteredViewModels.length > 0 && filteredViewModels.every((model) => model.enabled !== false);
  const allVisibleModelsDisabled = filteredViewModels.length > 0 && filteredViewModels.every((model) => model.enabled === false);
  const savedByModelId = new Map(saved.filter((entry) => entry.providerId === selectedProvider?.id).map((entry) => [`${entry.providerId}/${entry.modelId}`, entry]));

  return (
    <div className="models-management-page">
      <section className="models-usage-panel">
        <div className="models-usage-heading">
          <div>
            <strong>模型用途</strong>
            <span>默认模型只在这里管理；聊天输入栏切换只影响当前任务。</span>
          </div>
          <span className="models-usage-count">{selectableModels.length} 个可用聊天模型</span>
        </div>
        <details><summary>经评测的场景推荐（可选）</summary>
          <p>仅用于新会话；显式任务模型优先。只填已完成对照评测的报告路径；样本不足请保持空白。选择模型可能改变成本，任务上下文将发送到所选 provider。</p>
          {(["coding", "working"] as const).map(mode => <div key={mode}>
            <label>{mode}<select value={taskRecommendations[mode]?.modelId ?? ""} onChange={e => setTaskRecommendations({ ...taskRecommendations, [mode]: { modelId: e.target.value, evidencePath: taskRecommendations[mode]?.evidencePath ?? "" } })}>
              <option value="">不启用推荐</option>{selectableModels.map(model => <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>)}
            </select></label>
            <input placeholder="对照评测报告路径" value={taskRecommendations[mode]?.evidencePath ?? ""} onChange={e => setTaskRecommendations({ ...taskRecommendations, [mode]: { modelId: taskRecommendations[mode]?.modelId ?? "", evidencePath: e.target.value } })} />
          </div>)}
          <button className="btn" onClick={async () => {
            const saved = await window.api?.agent?.updateAppSettings?.({ taskModelRecommendations: taskRecommendations });
            setTaskRecommendations(saved?.taskModelRecommendations ?? {});
          }}>保存场景推荐</button>
        </details>
        <div className="models-usage-grid">
          <label className="models-usage-field">
            <span>主对话默认</span>
            <select
              value={defaultModelId}
              disabled={usageSaving || selectableModels.length === 0}
              onChange={(event) => void saveGlobalDefaultModel(event.target.value)}
            >
              {!defaultModelId && <option value="">请选择默认模型</option>}
              {defaultModelInvalid && <option value={defaultModelId}>不可用 · {defaultModelId}</option>}
              {selectableModels.map((model) => (
                <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>
              ))}
            </select>
            <small>新任务和未显式指定模型的执行使用此模型。</small>
          </label>

          <label className="models-usage-field">
            <span>Subagent 默认</span>
            <select
              value={subagentConfig?.defaultModel ?? ""}
              disabled={usageSaving || !subagentConfig}
              onChange={(event) => void changeSubagentModel(event.target.value)}
            >
              <option value="">跟随主对话默认</option>
              {subagentModelInvalid && subagentConfig?.defaultModel && (
                <option value={subagentConfig.defaultModel}>不可用 · {subagentConfig.defaultModel}</option>
              )}
              {selectableModels.map((model) => (
                <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>
              ))}
            </select>
            <small>Role frontmatter model: still overrides this default. A default is not a restriction; use the execution limits below to allow only specific models.</small>
          </label>

          <div className="models-usage-field">
            <span>Subagent 思考偏好</span>
            {!subagentTargetModel?.supportsReasoning ? (
              <small>当前目标模型不提供可调思考级别。</small>
            ) : (
              <>
                <select
                  value={subagentConfig?.defaultReasoning?.effort ?? ""}
                  disabled={usageSaving || !subagentConfig}
                  onChange={(event) => void saveSubagentDefaults({
                    defaultModel: subagentConfig?.defaultModel,
                    defaultReasoning: event.target.value ? { effort: event.target.value } : undefined,
                  })}
                >
                  <option value="">跟随模型思考偏好</option>
                  {subagentThinkingLevels.map((level) => (
                    <option key={level} value={level}>{reasoningEffortLabel(level, subagentTargetModel?.metadata)}</option>
                  ))}
                </select>
                <small>可选级别由 Pi 根据目标模型提供；留空时跟随该模型保存的思考偏好。</small>
              </>
            )}
          </div>
        </div>
        {subagentConfig && (
          <SubagentExecutionSettings
            models={selectableModels}
            config={subagentConfig}
            onSaved={setSubagentConfig}
          />
        )}
      </section>

      <div className="models-provider-layout">
      <aside className="models-provider-rail">
        <div className="models-provider-rail-title">模型提供商</div>
        <div className="models-provider-search">
          <IconSearch size={14} />
          <input value={providerFilter} placeholder="搜索提供商" onChange={(event) => setProviderFilter(event.target.value)} />
        </div>
        <div className="models-provider-scroll">
          <ProviderGroup title="已配置凭证" count={enabledProviders.length} providers={enabledProviders} selectedId={creatingProvider ? "" : selectedProviderId} onSelect={(id) => { setCreatingProvider(false); setSelectedProviderId(id); }} />
          <ProviderGroup title="未配置凭证" count={disabledProviders.length} providers={disabledProviders} selectedId={creatingProvider ? "" : selectedProviderId} onSelect={(id) => { setCreatingProvider(false); setSelectedProviderId(id); }} />
        </div>
        <button type="button" className={`models-provider-add ${creatingProvider ? "active" : ""}`} onClick={openAddProvider}>
          <IconPlus size={14} /> 添加
        </button>
      </aside>

      <section ref={detailRef} className="models-provider-detail">
        {creatingProvider ? (
          <>
            <div className="models-provider-detail-head">
              <div>
                <h3>添加自定义提供商</h3>
                <p>选择协议并填写 Provider 连接信息；模型可以保存后继续添加。</p>
              </div>
            </div>
            <ProviderForm draft={providerDraft} creating onPatch={patchProvider} />
            <div className="models-provider-models-section">
              <div className="models-provider-models-head">
                <div><strong>模型</strong><small>保存提供商后添加模型</small></div>
                <button type="button" className="btn" disabled><IconPlus size={14} /> 添加模型</button>
              </div>
              <div className="models-provider-empty-models">还没有模型。保存提供商后可以手动添加，也可以在 Provider 支持模型目录时刷新。</div>
            </div>
            <div className="models-provider-footer">
              <button type="button" className="btn" disabled={busy} onClick={() => { setCreatingProvider(false); setProviderDirty(false); }}>取消</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void saveProvider()}>{busy ? "保存中…" : "保存"}</button>
            </div>
            {hint && <div className="memory-status models-provider-hint">{hint}</div>}
          </>
        ) : selectedProvider ? (
          <>
            <div className="models-provider-detail-head">
              <div className="models-provider-identity">
                <div className="models-provider-logo">{selectedProvider.name.slice(0, 1).toUpperCase()}</div>
                <div>
                  <h3>{selectedProvider.name}</h3>
                  <p>{selectedProvider.login?.loggedIn ? "已配置凭证" : "未配置凭证"}{Object.prototype.hasOwnProperty.call(pausedProviderModels, selectedProvider.id) ? " · 已关闭" : ""} · {selectedProvider.id}</p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                className={`models-provider-state-switch ${selectedProvider.enabled ? "on" : ""}`}
                aria-label={`${selectedProvider.name} Provider`}
                aria-checked={selectedProvider.enabled}
                title={!selectedProvider.login?.loggedIn ? "请先配置凭证" : selectedProvider.enabled ? "关闭此 Provider，保留模型选择" : "开启此 Provider，恢复模型选择"}
                disabled={busy || !selectedProvider.login?.loggedIn}
                onClick={() => void toggleProviderEnabled()}
              ><span /></button>
            </div>

            <ProviderForm draft={providerDraft} creating={false} readOnly={!selectedProvider.config} onPatch={patchProvider} />

            <ProviderAuthSection
              provider={selectedProvider.login}
              pageBusy={busy}
              refreshLoginProviders={async () => { await refreshLoginProviders(); }}
              refreshSaved={refreshSaved}
              onLoginSuccess={(list, selectedModelId) => { applyModels(mapModelList(list), selectedModelId); void refreshUsageAssignments(); }}
            />

            <div className="models-provider-models-section">
              <div className="models-provider-models-head">
                <div><strong>模型</strong><small>{viewModels.length ? `已启用 ${viewModels.filter((model) => model.enabled !== false).length} / ${viewModels.length}${modelQuery ? ` · 显示 ${filteredViewModels.length}` : ""}` : "当前没有模型"} · Pi Runtime</small></div>
                <div className="models-provider-model-actions">
                  <button type="button" className="btn" disabled={busy} onClick={openAddModel}><IconPlus size={14} /> 添加模型</button>
                  <button type="button" className="icon-btn" title={busy ? "正在刷新…" : "刷新模型"} disabled={busy} onClick={() => void reloadModels()}><IconRefresh size={15} /></button>
                </div>
              </div>
              {viewModels.length > 0 && (
                <div className="models-provider-model-toolbar">
                  <div className="models-provider-model-filter">
                    <IconSearch size={14} />
                    <input value={modelFilter} placeholder="筛选模型名称或 ID" onChange={(event) => setModelFilter(event.target.value)} />
                  </div>
                  <div className="models-provider-model-batch-actions">
                    <button type="button" className="btn" disabled={busy || !selectedProvider.enabled || filteredViewModels.length === 0 || allVisibleModelsEnabled} onClick={() => void setVisibleModelsEnabled(filteredViewModels, true)}>全部启用</button>
                    <button type="button" className="btn" disabled={busy || !selectedProvider.enabled || filteredViewModels.length === 0 || allVisibleModelsDisabled} onClick={() => void setVisibleModelsEnabled(filteredViewModels, false)}>全部关闭</button>
                  </div>
                </div>
              )}
              {hint && <div className="memory-status models-provider-hint">{hint}</div>}
              {viewModels.length === 0 ? (
                <div className="models-provider-empty-models">没有模型。可以手动添加，也可以完成认证后点击刷新。</div>
              ) : filteredViewModels.length === 0 ? (
                <div className="models-provider-empty-models">没有匹配的模型。</div>
              ) : (
                <div className="models-provider-model-list">
                  {filteredViewModels.map((model) => {
                    const savedEntry = savedByModelId.get(model.id);
                    const isEnabled = model.enabled !== false;
                    const isDefault = defaultModelId === model.id;
                    const isSubagentDefault = subagentConfig?.defaultModel === model.id;
                    const isCurrentTask = activeModelId === model.id;
                    return (
                      <div key={model.id} className="models-provider-model-row">
                        <div className="models-provider-model-info">
                          <div className="models-provider-model-name">
                            {model.name}
                            {model.kind === "image-generation" && <span className="models-provider-tag models-provider-tag--vision">图像生成</span>}
                            {model.kind !== "image-generation" && model.supportsToolCall && <span className="models-provider-tag">工具</span>}
                            {model.kind !== "image-generation" && model.supportsImages && <span className="models-provider-tag models-provider-tag--vision">视觉</span>}
                            {model.kind !== "image-generation" && model.supportsReasoning && <span className="models-provider-tag models-provider-tag--reasoning">推理</span>}
                            {model.kind !== "image-generation" && model.metadata?.structuredOutput && <span className="models-provider-tag">结构化</span>}
                            {model.kind !== "image-generation" && <span className="models-provider-tag">{modelSourceLabel(model.metadata)}</span>}
                          </div>
                          {model.kind !== "image-generation" && <div className="models-provider-model-meta" title={model.id}>{model.id}</div>}
                          <div className="models-provider-model-meta">
                            {model.kind === "image-generation"
                              ? "Codex OAuth · GPT Image 2 · 生成 / 编辑"
                              : <>
                                  {modelLimitLabel(model.metadata, "contextWindow", model.contextWindow)}
                                  {` · ${modelLimitLabel(model.metadata, "maxTokens", model.metadata?.limits?.output)}`}
                                  {model.api ? ` · ${apiLabel(model.api)}` : ""}
                                  {reasoningControlSummary(model) ? ` · ${reasoningControlSummary(model)}` : ""}
                                  {model.supportsReasoning ? ` · 偏好 ${reasoningPreferenceSummary(modelPreferences[model.id]?.reasoning, model.metadata)}` : ""}
                                </>}
                          </div>
                        </div>
                        <div className="models-provider-model-row-actions">
                          {model.kind !== "image-generation" && <button type="button" className="icon-btn" title={savedEntry ? "模型详情 / 本地设置" : "模型详情"} onClick={() => openModelDetails(model)}><IconPencil size={14} /></button>}
                          {savedEntry && <button type="button" className="icon-btn" title="删除模型" disabled={busy} onClick={() => void deleteModel(savedEntry)}><IconTrash size={14} /></button>}
                          {model.kind !== "image-generation" && isDefault && <span className="models-provider-default-label">主默认</span>}
                          {model.kind !== "image-generation" && isSubagentDefault && <span className="models-provider-default-label models-provider-default-label--subagent">Subagent</span>}
                          {model.kind !== "image-generation" && isCurrentTask && <span className="models-provider-current-label">当前任务</span>}
                          <button
                            type="button"
                            className={`models-provider-model-toggle ${isEnabled ? "on" : ""}`}
                            title={isEnabled ? "关闭此模型" : "启用此模型"}
                            aria-pressed={isEnabled}
                            disabled={busy || !selectedProvider.enabled}
                            onClick={() => void toggleModelEnabled(model.id, !isEnabled, model.kind)}
                          ><span /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {(selectedProvider.config || providerDirty) && (
              <div className="models-provider-footer">
                {selectedProvider.config && <button type="button" className="btn danger" disabled={busy} onClick={() => void deleteProviderConfig()}>{selectedProvider.customOnly ? "删除 Provider" : "删除本地覆盖"}</button>}
                <span className="models-provider-footer-spacer" />
                {providerDirty && <button type="button" className="btn" disabled={busy} onClick={() => { setProviderDraft(providerDraftFrom(selectedProvider)); setProviderDirty(false); }}>取消修改</button>}
                <button type="button" className="btn primary" disabled={busy || !providerDirty} onClick={() => void saveProvider()}>保存</button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="models-provider-empty-detail">暂无 Provider。点击左下角「添加」创建自定义提供商。</div>
            {hint && <div className="memory-status models-provider-hint">{hint}</div>}
          </>
        )}
      </section>

      {editorOpen && editingEntry && (
        <ModelEditorModal
          mode={editorMode}
          initial={editingEntry}
          busy={busy}
          providerLocked
          onClose={() => setEditorOpen(false)}
          onSave={saveModelDraft}
        />
      )}
      </div>
    </div>
  );
}

function ProviderGroup({
  title,
  count,
  providers,
  selectedId,
  onSelect,
}: {
  title: string;
  count: number;
  providers: ProviderView[];
  selectedId: string;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="models-provider-group-nav">
      <div className="models-provider-group-nav-head"><span>{title}</span><span>{count}</span></div>
      {providers.map((provider) => (
        <button key={provider.id} type="button" className={`models-provider-nav-item ${selectedId === provider.id ? "active" : ""}`} onClick={() => onSelect(provider.id)}>
          <span className="models-provider-nav-logo">{provider.name.slice(0, 1).toUpperCase()}</span>
          <span className="models-provider-nav-name">{provider.name}</span>
          <span className={`models-provider-nav-dot ${provider.enabled ? "on" : ""}`} />
        </button>
      ))}
    </div>
  );
}

function ProviderForm({
  draft,
  creating,
  readOnly = false,
  onPatch,
}: {
  draft: ProviderDraft;
  creating: boolean;
  readOnly?: boolean;
  onPatch: (patch: Partial<ProviderDraft>) => void;
}): React.JSX.Element {
  return (
    <details className="models-provider-config-details" open={creating ? true : undefined}>
      <summary className="models-provider-config-summary">
        <span>Provider 配置</span>
        <span className="models-provider-config-summary-value">{apiLabel(draft.api)}</span>
      </summary>
      <div className="models-provider-form">
        <div className="models-provider-form-field">
          <label>协议</label>
          {creating ? (
            <div className="models-provider-protocols">
              {PROTOCOL_OPTIONS.map((option) => (
                <button key={option.id} type="button" className={`models-provider-protocol ${draft.api === option.id ? "active" : ""}`} onClick={() => onPatch({ api: option.id })}>
                  <span className="models-provider-radio" /> {option.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="models-provider-readonly">{apiLabel(draft.api)}</div>
          )}
        </div>
        <label className="models-provider-form-field">
          <span>名称</span>
          <input value={draft.name} readOnly={readOnly} onChange={(event) => { const name = event.target.value; onPatch(creating ? { name, id: slugifyProvider(name) } : { name }); }} placeholder="我的自定义提供商" />
        </label>
        {creating && (
          <label className="models-provider-form-field">
            <span>Provider ID</span>
            <input value={draft.id} onChange={(event) => onPatch({ id: slugifyProvider(event.target.value) })} placeholder="custom-provider" />
          </label>
        )}
        <label className="models-provider-form-field">
          <span>基础 URL</span>
          <input value={draft.baseUrl} readOnly={readOnly} onChange={(event) => onPatch({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" />
        </label>
        <label className="models-provider-form-field">
          <span>User-Agent</span>
          <input value={draft.userAgent} readOnly={readOnly} onChange={(event) => onPatch({ userAgent: event.target.value })} placeholder="Mozilla/5.0 ..." />
          <small>留空则使用运行时默认值，仅用于此 Provider 的模型请求。</small>
        </label>
      </div>
    </details>
  );
}
