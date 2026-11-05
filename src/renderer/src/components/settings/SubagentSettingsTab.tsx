import { useEffect, useMemo, useState } from "react";
import type { ModelInfoDto, SubagentConfigDto } from "@shared/agent-ipc";
import { reasoningEffortLabel } from "@shared/model-metadata";
import {
  modelOptionLabel,
  resolveSubagentReasoningAfterModelSwitch,
  targetSubagentModel,
  validateSubagentReasoningPreference,
} from "@shared/subagent-model-config";
import SubagentExecutionSettings from "./SubagentExecutionSettings";

export default function SubagentSettingsTab(): React.JSX.Element {
  const [models, setModels] = useState<ModelInfoDto[]>([]);
  const [defaultModelId, setDefaultModelId] = useState("");
  const [config, setConfig] = useState<SubagentConfigDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState("");

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const [settings, subagent, catalog] = await Promise.all([
          window.api?.agent?.getAppSettings?.(),
          window.api?.agent?.getSubagentConfig?.(),
          window.api?.agent?.listModels?.(),
        ]);
        if (!active) return;
        setDefaultModelId(settings?.defaultModelId ?? "");
        setConfig(subagent ?? null);
        setModels(catalog ?? []);
      } catch (error) {
        if (active) setHint(error instanceof Error ? error.message : String(error));
      }
    };
    void refresh();
    const onFocus = (): void => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { active = false; window.removeEventListener("focus", onFocus); };
  }, []);

  const selectableModels = useMemo(() => models.filter((model) =>
    model.kind !== "image-generation" && model.available !== false && model.enabled !== false,
  ), [models]);
  const targetModel = targetSubagentModel(selectableModels, config?.defaultModel, defaultModelId);
  const modelInvalid = Boolean(config?.defaultModel && !selectableModels.some((model) => model.id === config.defaultModel));

  const saveDefaults = async (patch: Pick<SubagentConfigDto, "defaultModel" | "defaultReasoning">): Promise<void> => {
    if (!config) return;
    const merged = { ...config, ...patch };
    const validation = validateSubagentReasoningPreference({
      defaultModel: merged.defaultModel,
      preference: merged.defaultReasoning,
      models: selectableModels,
      globalDefaultModelId: defaultModelId,
    });
    setSaving(true);
    setHint("");
    try {
      const next = await window.api?.agent?.saveSubagentConfig?.({
        defaultModel: merged.defaultModel,
        defaultReasoning: validation.preference,
        expectedRevision: config.revision,
      });
      if (!next) throw new Error("子代理设置接口不可用。");
      setConfig(next);
      setHint(validation.problems.length ? validation.problems.join("；") : "子代理模型策略已更新");
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const changeModel = async (modelId: string): Promise<void> => {
    if (!config) return;
    const nextModel = modelId || undefined;
    const resolved = resolveSubagentReasoningAfterModelSwitch({
      previous: config.defaultReasoning,
      newModelId: nextModel,
      models: selectableModels,
      globalDefaultModelId: defaultModelId,
    });
    await saveDefaults({ defaultModel: nextModel, defaultReasoning: resolved.preference });
    if (resolved.problem) setHint(resolved.problem);
  };

  return (
    <div className="models-management-page subagent-settings-page">
      <section className="models-usage-panel subagent-settings-panel">
        <div className="models-usage-heading">
          <div><strong>子代理设置</strong><span>配置子代理默认模型、思考偏好和执行限制。</span></div>
        </div>
        <div className="models-usage-grid subagent-defaults-grid">
          <label className="models-usage-field">
            <span>子代理默认模型</span>
            <select value={config?.defaultModel ?? ""} disabled={saving || !config} onChange={(event) => void changeModel(event.target.value)}>
              <option value="">跟随主对话默认</option>
              {modelInvalid && config?.defaultModel && <option value={config.defaultModel}>不可用 · {config.defaultModel}</option>}
              {selectableModels.map((model) => <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>)}
            </select>
            <small>角色配置中指定的模型仍会优先使用。默认模型不限制可选范围；如需限制，请在下方执行限制中设置。</small>
          </label>
          <div className="models-usage-field">
            <span>子代理思考偏好</span>
            {!targetModel?.supportsReasoning ? <small>当前目标模型不提供可调思考级别。</small> : <>
              <select value={config?.defaultReasoning?.effort ?? ""} disabled={saving || !config} onChange={(event) => void saveDefaults({ defaultModel: config?.defaultModel, defaultReasoning: event.target.value ? { effort: event.target.value } : undefined })}>
                <option value="">跟随模型思考偏好</option>
                {(targetModel.thinkingLevels ?? []).map((level) => <option key={level} value={level}>{reasoningEffortLabel(level, targetModel.metadata)}</option>)}
              </select>
              <small>可选级别由 Pi 根据目标模型提供；留空时跟随该模型保存的思考偏好。</small>
            </>}
          </div>
        </div>
        {hint && <div className="memory-status" role="status">{hint}</div>}
        {config && <SubagentExecutionSettings models={selectableModels} config={config} onSaved={setConfig} />}
      </section>
    </div>
  );
}
