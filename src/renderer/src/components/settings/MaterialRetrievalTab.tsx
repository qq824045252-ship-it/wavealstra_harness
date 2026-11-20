import { useEffect, useState } from "react";
import type { ModelInfoDto } from "@shared/agent-ipc";
import type { MaterialRetrievalMode, MaterialRetrievalSettings } from "@shared/materialRetrieval";
import { SettingsSection, SettingsSelect } from "./SettingsPrimitives";

const modelStatusLabels: Record<string, string> = {
  not_installed: "未安装",
  downloading: "下载中",
  ready: "已就绪",
  corrupt: "模型文件损坏",
  failed: "加载失败",
};

export default function MaterialRetrievalTab(): React.JSX.Element {
  const api = window.api;
  const [settings, setSettings] = useState<MaterialRetrievalSettings>();
  const [models, setModels] = useState<ModelInfoDto[]>([]);
  const [modelsReady, setModelsReady] = useState(false);
  const [status, setStatus] = useState<{ model: string; error: string | null; running: boolean; completed: number; pending: number; total: number }>();
  const [statusError, setStatusError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [modelListError, setModelListError] = useState(false);

  useEffect(() => {
    if (!api?.materialRetrieval) {
      setError("资料检索设置暂不可用");
      return;
    }
    const { materialRetrieval, agent, db } = api;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    void materialRetrieval.getSettings().then(value => {
      if (active) setSettings(value);
    }).catch(() => {
      if (active) setError("无法读取资料检索设置");
    });
    void agent.listModels().then(list => {
      if (!active) return;
      setModels(list.filter(model => model.kind !== "image-generation" && model.enabled !== false && model.available !== false));
      setModelsReady(true);
    }).catch(() => {
      if (active) setModelListError(true);
    });

    async function refresh(): Promise<void> {
      try {
        const [model, index] = await Promise.all([db.getSemanticModelStatus(), db.getSemanticIndexStats()]);
        if (active) {
          setStatus({ ...index, model: model.status, error: model.error });
          setStatusError(false);
        }
      } catch {
        if (active) setStatusError(true);
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 2000);
      }
    }

    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [api]);

  async function save(patch: Partial<MaterialRetrievalSettings>): Promise<void> {
    if (!api?.materialRetrieval) return;
    setSaving(true);
    setError("");
    try {
      setSettings(await api.materialRetrieval.setSettings(patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法保存资料检索设置");
    } finally {
      setSaving(false);
    }
  }

  const selectedModel = settings?.decisionModel ?? "";
  return <>
    <SettingsSection title="默认检索方式" description="空间和项目可单独覆盖全局默认设置。">
      <SettingsSelect
        label="检索方式"
        value={settings?.mode ?? ""}
        disabled={!settings || saving}
        onChange={event => void save({ mode: event.target.value as MaterialRetrievalMode })}
      >
        {!settings && <option value="">正在读取</option>}
        <option value="keyword">关键词检索</option>
        <option value="hybrid">混合检索 · 关键词 + 语义</option>
      </SettingsSelect>
    </SettingsSection>
    <SettingsSection title="BGE-M3 语义索引" description="统计当前启用混合检索的资料片段。">
      <div className="settings-row" aria-live="polite">
        <span className="settings-row-label">本地模型</span>
        <span>{statusError ? "读取失败" : status ? modelStatusLabels[status.model] ?? status.model : "正在读取"}</span>
      </div>
      {status?.error && !statusError && <p className="settings-field-hint">{status.error}</p>}
      <div className="settings-row" aria-live="polite">
        <span className="settings-row-label">{status?.running ? "正在索引" : "索引进度"}</span>
        <span>{statusError ? "读取失败" : status ? `已完成 ${status.completed} · 待处理 ${status.pending}` : "正在读取"}</span>
      </div>
    </SettingsSection>
    <SettingsSection title="SAG2 决策模型">
      <SettingsSelect
        label="决策模型"
        hint="资料深搜需要配置决策模型。使用远程模型时，深搜会发送问题和候选片段。"
        value={selectedModel}
        disabled={!settings || !modelsReady || saving}
        onChange={event => void save({ decisionModel: event.target.value || null })}
      >
        <option value="">未配置</option>
        {selectedModel && !models.some(model => model.id === selectedModel) && <option value={selectedModel} disabled>{selectedModel}（不可用）</option>}
        {models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.vendor}</option>)}
      </SettingsSelect>
      {modelListError && <p role="alert">无法读取模型列表</p>}
    </SettingsSection>
    {error && <p role="alert">{error}</p>}
  </>;
}
