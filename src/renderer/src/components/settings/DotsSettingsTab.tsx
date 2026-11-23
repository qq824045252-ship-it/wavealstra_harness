import { useEffect, useState } from "react";
import { defaultDotsMemoryLimits, dotsMemoryLimitFields, type DotsMemoryLimit, type DotsMemoryLimits } from "@shared/dots-limits";
import { dotsCapabilityOptions, dotsOperationEnabled, dotsOperations, resolveDotsPreferences, type DotsOperation, type DotsSettings } from "@shared/dots-settings";
import type { AppSettingsDto, ModelInfoDto, SpaceDto } from "@shared/agent-ipc";
import { DOTS_TASK_ID, dotsLocalSpacePath } from "@shared/dots";
import { useAppStore } from "@/store/appStore";
import AnswerRoutingTab from "./AnswerRoutingTab";
import DotsPromptSection from "./DotsPromptSection";
import MemoryKernelExplorer from "./MemoryKernelExplorer";
import { SettingsInput, SettingsSection, SettingsSelect } from "./SettingsPrimitives";
import "./DotsSettingsTab.css";
import "./Memory.css";

const sections = ["调度", "提示词", "模型与记忆", "专属记忆", "读取额度", "跟进与空间", "工具与操作"] as const;
const dotsMemoryScope = { scopeType: "task", scopeId: DOTS_TASK_ID } as const;
const allOperations = Object.keys(dotsOperations) as DotsOperation[];
const memoryWrites = new Set<DotsOperation>(["memory_create", "memory_update", "memory_promote", "memory_forget"]);
const memoryLimitKeys = Object.keys(dotsMemoryLimitFields) as DotsMemoryLimit[];
const memoryLimitGroups = [
  { id: "automatic", label: "自动带入对话", description: "从新一轮开始生效。实际带入量取决于可用记忆和模型的上下文空间。" },
  { id: "lookup", label: "主动查找记忆", description: "这里设置搜索和历史预览。打开单条记忆时可读取完整正文。" },
] as const;

function MemoryLimitsForm({ limits, onSave }: { limits: DotsMemoryLimits; onSave(limits: DotsMemoryLimits): void }) {
  return <form aria-label="Dots 记忆读取额度" onSubmit={event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const next = { ...limits };
    for (const key of memoryLimitKeys) next[key] = Number(values.get(key));
    onSave(next);
  }} onReset={() => onSave(defaultDotsMemoryLimits)}>
    {memoryLimitGroups.map(group => <fieldset className="dots-memory-limits-group" key={group.id}>
      <legend>{group.label}</legend>
      <p className="settings-section-desc">{group.description}</p>
      <div className="dots-memory-limits-fields">
        {memoryLimitKeys.filter(key => dotsMemoryLimitFields[key].group === group.id).map(key => {
          const field = dotsMemoryLimitFields[key];
          return <SettingsInput key={key} name={key} label={field.label} type="number" required step={1}
            min={field.min} max={field.max} defaultValue={limits[key]}
            hint={field.min === 0 ? "填 0 可关闭此项" : undefined} />;
        })}
      </div>
    </fieldset>)}
    <div className="dots-memory-limits-actions">
      <button className="btn primary" type="submit">保存记忆额度</button>
      <button className="btn" type="reset">恢复默认并保存</button>
    </div>
  </form>;
}

function Switch({ label, subject, on, change }: {
  label: string; subject?: string; on: boolean; change(): void;
}) {
  return <button className="dots-setting-switch" type="button" role="switch" aria-checked={on} aria-label={label} onClick={change}>
    <span>{subject}{on ? "已开启" : "已关闭"}</span><span aria-hidden="true" className={`switch${on ? " on" : ""}`} />
  </button>;
}

export default function DotsSettingsTab() {
  const [section, setSection] = useState<typeof sections[number]>(sections[0]);
  const showScheduling = section === "调度";
  const [settings, setSettings] = useState<AppSettingsDto>();
  const [models, setModels] = useState<ModelInfoDto[]>([]);
  const [spaces, setSpaces] = useState<SpaceDto[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (showScheduling) return;
    const api = window.api;
    if (!api?.agent) { setError("设置服务尚未就绪"); return; }
    let active = true;
    void api.agent.getAppSettings().then(result => {
      if (active) setSettings(result);
    }).catch(e => { if (active) setError(String(e)); });
    void api.agent.listModels().then(rows => { if (active) setModels(rows); }).catch(e => { if (active) setError(String(e)); });
    void api.db.listSpaces().then(rows => { if (active) setSpaces(rows); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [showScheduling]);

  async function save(label: string, patch: Partial<DotsSettings>) {
    setSaving(true);
    setSaved("");
    setError("");
    try {
      const agent = window.api?.agent;
      if (!agent) throw new Error("设置服务尚未就绪");
      const result = await agent.updateAppSettings({ dotsSettings: patch });
      if (!result.dotsSettingsRuntime) throw new Error("当前主进程未加载 Dots 设置，请重新启动 MyBuddy。");
      setSettings(result);
      if (patch.modelId !== undefined) await useAppStore.getState().refreshModelConfiguration();
      setSaved(label + "已保存");
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  const prefs = resolveDotsPreferences(settings?.dotsSettings);
  const byId = new Map(spaces.map(space => [space.id, space]));
  const selectableSpaces = spaces.flatMap(space => {
    if (space.effectiveArchived || space.archived) return [];
    const name = dotsLocalSpacePath(space, id => byId.get(id))?.join(" / ");
    return name ? [{ ...space, label: name }] : [];
  });
  const chatModels = models.filter(m => m.enabled !== false && m.available !== false && m.kind !== "image-generation");
  const mainModel = models.find(m => m.id === settings?.defaultModelId)?.name ?? settings?.defaultModelId;
  const openSettings = useAppStore(s => s.setSettingsOpen);
  const mode = settings?.memoryEnabled ? prefs.memoryMode : "off";
  return <div className="dots-config">
    <nav aria-label="Dots 设置分类">{sections.map(name =>
      <button type="button" key={name} aria-pressed={section === name} onClick={() => { setSection(name); setSaved(""); }}>{name}</button>)}</nav>
    <div hidden={!showScheduling}><AnswerRoutingTab /></div>
    {!showScheduling && <>
    {error && <p role="alert">{error}</p>}
    {!settings ? (!error && <p role="status">正在读取 Dots 设置…</p>) : !settings.dotsSettingsRuntime ?
      <p role="alert">当前运行的 MyBuddy 主进程还不支持这些设置。请完全退出并重开 MyBuddy。</p> : <>
      <fieldset disabled={saving}>
      {section === "模型与记忆" && <>
        <SettingsSection title="对话模型">
          <SettingsSelect label="Dots 使用的模型" value={prefs.modelId ?? ""} onChange={e => void save("对话模型", { modelId: e.target.value || null })}>
            <option value="">跟随主模型{mainModel ? " · " + mainModel : "（尚未设置）"}</option>
            {prefs.modelId && !chatModels.some(m => m.id === prefs.modelId) && <option value={prefs.modelId}>当前不可用 · {prefs.modelId}</option>}
            {chatModels.map(m => <option key={m.id} value={m.id}>{m.name} · {m.vendor}</option>)}
          </SettingsSelect>
          <p className="settings-row-desc">在这里选择模型只影响 Dots。新建普通任务使用应用主模型。</p>
        </SettingsSection>
        <SettingsSection title="长期记忆">
          <SettingsSelect label="Dots 如何使用长期记忆" hint="控制 Dots 在对话中的记忆读写。"
            value={prefs.memoryMode} onChange={e => void save("长期记忆", {memoryMode: e.target.value as DotsSettings["memoryMode"]})}>
            <option value="readWrite">读取并记住新信息</option><option value="readOnly">只读取已有记忆</option><option value="off">关闭长期记忆</option>
          </SettingsSelect>
          {!settings.memoryEnabled && <p className="settings-row-desc">应用记忆已关闭。开启后会使用这里保存的选择。 <button className="btn" type="button" onClick={() => openSettings(true, "memory")}>打开应用记忆设置</button></p>}
        </SettingsSection>
      </>}
      {section === "专属记忆" && (
        <div className="memory-tab">
          <MemoryKernelExplorer fixedScope={dotsMemoryScope} />
        </div>
      )}
      {section === "读取额度" && (
        <SettingsSection title="记忆读取额度">
          <MemoryLimitsForm key={JSON.stringify(prefs.memoryLimits)} limits={prefs.memoryLimits}
            onSave={memoryLimits => void save("记忆读取额度", { memoryLimits })} />
        </SettingsSection>
      )}
      {section === "跟进与空间" && <>
        <SettingsSection title="主动跟进">
          <SettingsSelect label="到时间或有实质进展时" value={prefs.followupMode} onChange={e => void save("主动跟进", {followupMode: e.target.value as DotsSettings["followupMode"]})}>
            <option value="continue">自动继续已授权的工作</option><option value="notify">只通知，由我决定是否继续</option><option value="paused">暂停主动跟进和提醒</option>
          </SettingsSelect>
          <p className="settings-row-desc">已交办任务的最终成果和阻塞问题仍回到原对话。</p>
        </SettingsSection>
        <SettingsSection title="可访问的工作空间">
          <SettingsSelect label="空间范围" value={prefs.spaceIds === null ? "all" : "selected"} onChange={e => void save("空间范围", {spaceIds: e.target.value === "all" ? null : []})}>
            <option value="all">全部本地工作空间</option><option value="selected">仅勾选的工作空间</option>
          </SettingsSelect>
          {prefs.spaceIds !== null && <><p className="settings-row-desc">已选 {selectableSpaces.filter(s => prefs.spaceIds!.includes(s.id)).length} 个。子空间可单独勾选。</p>
            {selectableSpaces.map(space => <label className="dots-config-check" key={space.id}>
              <input type="checkbox" checked={prefs.spaceIds!.includes(space.id)} onChange={e => void save("空间范围",
                {spaceIds: e.target.checked ? [...prefs.spaceIds!, space.id] : prefs.spaceIds!.filter(id => id !== space.id)})} />
              <span>{space.label}{space.path && <small>{space.path}</small>}</span></label>)}</>}
        </SettingsSection>
      </>}
      {section === "工具与操作" && <SettingsSection title="Dots 可调用的工具" description="展开每组可单独修改操作。暂停和取消已交办的事项始终可用。">
        {dotsCapabilityOptions.map(({id, label, description}) => {
          const ops = allOperations.filter(key => dotsOperations[key][0] === id);
          const effective = (key: DotsOperation) => dotsOperationEnabled(prefs, key) && (id !== "memoryTools" || mode !== "off" && (mode !== "readOnly" || !memoryWrites.has(key)));
          return <div key={id} className="dots-tool-group">
            <details><summary><span>{label}</span><small>{ops.filter(effective).length} / {ops.length} 项开启</small></summary>
              <p className="settings-row-desc">{description}</p>
              {ops.map(key => {
                const accessible = dotsOperationEnabled({...prefs, operations: {}}, key) && (id !== "memoryTools" || mode !== "off" && (mode !== "readOnly" || !memoryWrites.has(key)));
                return <label className="dots-config-check" key={key}><input type="checkbox" checked={effective(key)} disabled={!accessible}
                  onChange={e => void save(dotsOperations[key][1], {operations: {[key]: e.target.checked}})} />{dotsOperations[key][1]}</label>;
              })}
            </details>
            <Switch label={label} subject={id === "taskControl" ? "任务调度" : id === "spaceManagement" ? "空间修改" : undefined}
              on={prefs[id]} change={() => void save(label, {[id]: !prefs[id]})} />
          </div>;
        })}
      </SettingsSection>}
      </fieldset>
      {section === "提示词" && <DotsPromptSection value={settings.dotsPromptAppend ?? ""} onSaved={setSettings} />}
      <div className="dots-setting-feedback" role="status">{saving ? "正在保存…" : saved}</div>
    </>}
    </>}
  </div>;
}
