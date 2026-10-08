import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "@/store/appStore";
import type { TaskExpertBindingDto } from "@shared/expert-binding";
import { ExpertCapabilityFields } from "./ExpertCapabilityFields";
import { HubAuthoringModal } from "./HubAuthoringModal";
import "@/styles/expert-editor.css";

export function ExpertBindingModal({ taskId, onClose }: { taskId: string; onClose: () => void }): React.JSX.Element {
  const experts = useAppStore((s) => s.experts);
  const skills = useAppStore((s) => s.skills);
  const refreshExperts = useAppStore((s) => s.refreshExperts);
  const refreshBinding = useAppStore((s) => s.refreshTaskExpertBinding);
  const saveBinding = useAppStore((s) => s.saveTaskExpertBinding);
  const liveBinding = useAppStore((s) => s.tasks.find((task) => task.id === taskId)?.expertBinding);
  const [binding, setBinding] = useState<TaskExpertBindingDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [authoring, setAuthoring] = useState<string | "new" | null>(null);
  useEffect(() => {
    if (liveBinding) setBinding((current) => current && current.desired?.revision === liveBinding.desired?.revision ? liveBinding : current);
  }, [liveBinding]);
  const readBinding = (value: TaskExpertBindingDto): void => {
    setBinding(value); setName(value.desired?.name ?? ""); setInstructions(value.desired?.instructions ?? "");
    setSkillIds(value.desired?.skillIds ?? []); setMcpIds(value.desired?.mcpIds ?? []); setConnectorIds(value.desired?.connectorIds ?? []);
    setSelectedId(value.desired?.sourceExpertId ?? "");
  };
  useEffect(() => {
    let cancelled = false;
    void refreshBinding(taskId).then((value) => { if (!cancelled) readBinding(value); }).catch((err) => { if (!cancelled) setError(String(err)); }).finally(() => { if (!cancelled) setLoading(false); });
    void refreshExperts().catch(() => {});
    void useAppStore.getState().refreshSkills().catch(() => {});
    void useAppStore.getState().refreshConnectors().catch(() => {});
    return () => { cancelled = true; };
  }, [taskId, refreshBinding, refreshExperts]);
  const save = async (change: { expertId?: string | null; custom?: { name: string; instructions: string; skillIds: string[]; mcpIds: string[]; connectorIds: string[] } }): Promise<void> => {
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await saveBinding({ taskId, expectedRevision: binding?.desired?.revision ?? null, ...change });
      readBinding(value);
      setNotice(value.pending ? "已保存。当前执行沿用原身份，下一次空闲后的新输入生效。" : "已保存当前任务的专家配置。");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); throw err; }
    finally { setBusy(false); }
  };
  const source = experts.find((expert) => expert.id === binding?.desired?.sourceExpertId);
  const selected = experts.find((expert) => expert.id === selectedId);
  return createPortal(<>
    <div className="modal-overlay expert-editor-overlay" onClick={(event) => event.stopPropagation()}><div className="mcp-auth-modal expert-editor-modal" role="dialog" aria-modal="true" aria-label="管理当前任务专家">
      <div className="mcp-auth-title">管理当前任务专家</div>
      <div className="expert-editor-scope">以下修改只影响这条任务。身份、Skills、MCP 和连接器会随任务保存；修改模板需要单独打开“编辑专家模板”。</div>
      {loading ? <div>读取任务配置…</div> : <>
        {binding?.pending && <div className="expert-editor-notice expert-editor-warning">待生效：{binding.desired?.name ?? "解除专家"}。当前执行：{binding.active?.name ?? "未绑定专家"}。</div>}
        {binding?.desired?.sourceExpertId && !source && <div className="expert-editor-notice expert-editor-warning">原专家模板已卸载或不可用，当前任务保留身份快照，可继续编辑或解除绑定。</div>}
        {binding?.warnings?.map((warning) => <div key={warning} className="expert-editor-notice expert-editor-warning">{warning}</div>)}
        <label className="expert-editor-field"><span className="mcp-auth-hint">选择专家模板</span><div className="expert-editor-inline"><select className="mcp-auth-input" value={selectedId} disabled={busy} onChange={(e) => setSelectedId(e.target.value)}><option value="">选择已安装专家…</option>{selectedId && !selected && <option value={selectedId}>{binding?.desired?.name ?? selectedId}（模板不可用）</option>}{experts.map((expert) => <option key={expert.id} value={expert.id} disabled={!expert.enabled}>{expert.name}{expert.enabled ? "" : "（已停用）"}</option>)}</select><button type="button" className="btn" disabled={busy || !selected?.enabled} onClick={() => void save({ expertId: selectedId }).catch(() => {})}>{binding?.desired?.sourceExpertId === selectedId ? "同步模板" : "绑定到此任务"}</button></div></label>
        <div className="expert-editor-inline"><button type="button" className="btn" disabled={busy} onClick={() => setAuthoring("new")}>创建专家并绑定</button><button type="button" className="btn" disabled={busy || !selected} onClick={() => setAuthoring(selectedId)}>查看 / 编辑专家模板</button></div>
        <label className="expert-editor-field"><span className="mcp-auth-hint">当前任务身份名称 *</span><input className="mcp-auth-input" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
        <label className="expert-editor-field"><span className="mcp-auth-hint">当前任务角色说明 *</span><textarea className="mcp-auth-input" rows={8} value={instructions} disabled={busy} onChange={(e) => setInstructions(e.target.value)} /></label>
        <ExpertCapabilityFields skills={skills} skillIds={skillIds} mcpIds={mcpIds} connectorIds={connectorIds} onSkills={setSkillIds} onMcp={setMcpIds} onConnectors={setConnectorIds} disabled={busy} />
      </>}
      {error && <div className="mcp-auth-error" role="alert">{error}</div>}{notice && <div className="expert-editor-notice" role="status">{notice}</div>}
      <div className="mcp-auth-actions"><button type="button" className="btn primary" disabled={busy || loading || !name.trim() || !instructions.trim()} onClick={() => void save({ custom: { name: name.trim(), instructions: instructions.trim(), skillIds, mcpIds, connectorIds } }).catch(() => {})}>{busy ? "保存中…" : "仅保存到当前任务"}</button><button type="button" className="btn" disabled={busy || loading || !binding?.desired} onClick={() => void save({ expertId: null }).catch(() => {})}>解除绑定</button><button type="button" className="btn" disabled={busy} onClick={onClose}>关闭</button></div>
    </div></div>
    {authoring && <HubAuthoringModal mode="expert" skills={skills} expertId={authoring === "new" ? undefined : authoring} onClose={() => setAuthoring(null)} onCreated={async () => { await refreshExperts(); }} onExpertSaved={authoring === "new" ? async (expert) => { await save({ expertId: expert.id }); } : undefined} />}
  </>, document.body);
}
