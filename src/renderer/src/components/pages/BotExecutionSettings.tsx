import { useAppStore } from "@/store/appStore";
import { useEffect, useState } from "react";
import type { BotSettingsDto, BotSettingsView, BotSettingsChoice } from "@shared/bot-settings";

export function BotExecutionSettings({ botId }: { botId: string }): React.JSX.Element {
  const [view, setView] = useState<BotSettingsView>();
  const [draft, setDraft] = useState<BotSettingsDto>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setView(undefined); setDraft(undefined); setNotice("");
    if (!window.api?.botWork.getSettings) { setNotice("Bot 设置接口尚未就绪，请重启应用后重试"); return; }
    void window.api.botWork.getSettings(botId).then(value => { if (alive) { setView(value); setDraft(value.settings); } })
      .catch(error => { if (alive) setNotice(String(error)); });
    return () => { alive = false; };
  }, [botId]);
  const save = async () => {
    if (!draft) return;
    setBusy(true); setNotice("");
    try {
      if (!window.api) throw new Error("桌面接口不可用");
      const result = await window.api.botWork.saveSettings({ botId, expectedRevision: draft.revision,
        workspacePath: draft.workspacePath, modelId: draft.modelId, expertId: draft.expertId,
        skillIds: draft.skillIds, mcpIds: draft.mcpIds, connectorIds: draft.connectorIds });
      if (!result.ok) throw new Error(result.message);
      setView(result.view); setDraft(result.view.settings);
      await useAppStore.getState().refreshSpaces();
      setNotice("已保存。模型在下一条对话生效；工作空间和能力用于后续新任务，已有任务保持原配置。");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const choices = (label: string, key: "skillIds" | "mcpIds" | "connectorIds", options: BotSettingsChoice[]) => <fieldset>
    <legend>{label}</legend>
    {options.length ? options.map(item => <label key={item.id} className="bot-setting-choice">
      <input type="checkbox" checked={draft![key].includes(item.id)} disabled={busy || (!item.available && !draft![key].includes(item.id))}
        onChange={event => setDraft(current => current && ({ ...current, [key]: event.target.checked ? [...current[key], item.id] : current[key].filter(id => id !== item.id) }))} />
      {item.name}{!item.available && "（未启用）"}
    </label>) : <p>暂无已安装的{label}，可先到应用设置中添加。</p>}
    {draft![key].filter(id => !options.some(item => item.id === id)).map(id => <label key={id} className="bot-setting-choice"><input type="checkbox" checked disabled={busy} onChange={() => setDraft(current => current && ({...current, [key]: current[key].filter(value => value !== id)}))} />{id}（不可用，取消勾选可移除）</label>)}
  </fieldset>;
  return <section className="bot-execution-settings" aria-label="Bot 执行设置"><h3>工作空间与能力</h3>
    {view && draft ? <>
      <label>工作文件夹<input aria-label="Bot 工作文件夹" value={draft.workspacePath} placeholder={draft.effectiveWorkspacePath} disabled={busy} onChange={event => setDraft({...draft, workspacePath: event.target.value})} /></label>
      <button type="button" disabled={busy} onClick={() => { void window.api?.pickLocalFolder().then(folder => { if (folder) setDraft(current => current && ({...current, workspacePath: folder.path})); }).catch(error => setNotice(String(error))); }}>选择文件夹</button>
      <p>留空使用 Bot 专用目录。后台任务归入「Bot 名称 · 工作空间」，不再堆在个人任务里。修改目录不移动旧文件或运行中的任务。</p>
      <label>模型<select aria-label="Bot 模型" disabled={busy} value={draft.modelId} onChange={event => setDraft({...draft, modelId: event.target.value})}><option value="">跟随应用默认模型</option>{view.models.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.name}{!item.available ? "（不可用）" : ""}</option>)}</select></label>
      <label>专家<select aria-label="Bot 专家" disabled={busy} value={draft.expertId} onChange={event => setDraft({...draft, expertId: event.target.value})}><option value="">使用 Bot 自身职责</option>{view.experts.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.name}</option>)}</select></label>
      <p>专家指令用于对话与新任务，专家自带能力一并挂载。下方可额外挂载能力，真实工具在后台任务中执行。</p>
      {choices("Skill", "skillIds", view.skills)}{choices("MCP", "mcpIds", view.mcps)}{choices("连接器", "connectorIds", view.connectors)}
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存 Bot 设置"}</button>
    </> : !notice && <p>正在读取设置…</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
