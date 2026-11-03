import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, ChevronDown, ChevronRight, RotateCcw, Check, Pause, Play, AlertCircle } from "lucide-react";
import type { MemoryOrganizationProposal, MemoryOrganizationRun } from "@shared/memory-organization";
import type { MemoryScopeDto } from "@shared/memory-kernel";

const ACTIONS = { merge: "合并重复", rewrite: "精简正文", split: "拆分事实", retire: "退出召回", conflict: "待确认冲突" };
function Proposal({ proposal, scopeName, onOpen }: {
  proposal: MemoryOrganizationProposal; scopeName: (scope: MemoryScopeDto) => string; onOpen: (id: string) => void;
}) {
  return <details className={`memory-organization-proposal ${proposal.action === "conflict" ? "is-conflict" : ""}`}>
    <summary><span className="memory-organization-action">{ACTIONS[proposal.action]}</span>
      <strong>{proposal.after[0]?.title ?? proposal.before[0]?.title}</strong><span>{proposal.before.length} → {proposal.action === "conflict" ? "待确认" : proposal.after.length}</span></summary>
    <p className="memory-organization-reason">{proposal.reason}</p>
    <div className="memory-organization-scope">{proposal.scopes.map(scopeName).join(" · ")}</div>
    <div className="memory-organization-comparison">
      <div><h4>整理前</h4>{proposal.before.map(item => <article key={item.id}><button type="button" className="memory-text-button" onClick={() => onOpen(item.id)}>{item.title}</button><p>{item.content}</p></article>)}</div>
      <div><h4>{proposal.action === "conflict" ? "需要确认" : "整理后"}</h4>{proposal.after.map((item, index) => <article key={index}><strong>{item.title}</strong><p>{item.content}</p></article>)}
        {!proposal.after.length && <p>{proposal.action === "conflict" ? "保留原有记忆，不自动决定哪条正确。可打开来源记忆查看并编辑。" : "保留历史和来源，不再参与默认召回。"}</p>}</div>
    </div>
  </details>;
}

export default function MemoryOrganizationPanel({ activeCount, scopeName, onOpen, onChanged }: {
  activeCount: number; scopeName: (scope: MemoryScopeDto) => string; onOpen: (id: string) => void; onChanged: () => Promise<void>;
}) {
  const [run, setRun] = useState<MemoryOrganizationRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const mounted = useRef(true);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++request.current;
    try {
      const value = await window.api?.memory?.organization?.();
      if (mounted.current && ticket === request.current) setRun(value ?? null);
    } catch (e) { if (mounted.current && ticket === request.current) setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = window.api?.db?.onMemoryChanged?.(() => void refresh());
    return () => { mounted.current = false; request.current++; unsubscribe?.(); };
  }, [refresh]);
  useEffect(() => {
    if (run?.status !== "scanning") return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [run?.status, refresh]);
  const act = async (operation: "start" | "resume" | "pause" | "apply" | "undo" | "dismiss") => {
    const api = window.api?.memory;
    if (!api || busy) return;
    setBusy(true); setError(""); request.current++;
    try {
      const value = operation === "start" ? await api.startOrganization()
        : operation === "resume" ? await api.startOrganization(run!.id)
        : operation === "pause" ? await api.pauseOrganization(run!.id)
        : operation === "apply" ? await api.applyOrganization(run!.id)
        : operation === "undo" ? await api.undoOrganization(run!.id)
        : await api.dismissOrganization(run!.id);
      if (!mounted.current) return;
      request.current++; setRun(value);
      if (operation === "apply" || operation === "undo") await onChanged();
      if (operation === "start" || operation === "resume") setExpanded(true);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const pending = run && ["scanning", "paused", "ready"].includes(run.status);
  const changes = run?.proposals.filter(p => p.action !== "conflict") ?? [];
  const conflicts = run?.proposals.filter(p => p.action === "conflict") ?? [];
  const removed = changes.reduce((n, p) => n + p.before.length - p.after.length, 0);
  const coverage = run ? Math.min(100, Math.round((run.scanned + run.skipped) / Math.max(1, run.total) * 100)) : 0;
  const status = run?.status === "scanning" ? "正在整理全部记忆"
    : run?.status === "paused" ? "整理已暂停，进度已保存"
    : run?.status === "ready" ? run.proposals.length ? "整理完成 · 查看变更后应用" : "检查完成 · 暂无需要整理的内容"
    : run?.status === "applied" ? "整理已应用" : run?.status === "undone" ? "已撤销上次整理" : "让记忆更简洁、更好用";
  return <section className="memory-organization" aria-label="AI 整理记忆">
    <div className="memory-organization-heading">
      <div className="memory-organization-icon"><Sparkles size={19} /></div>
      <div className="memory-organization-intro"><h3>AI 整理记忆</h3><p>{status}</p></div>
      <div className="memory-organization-buttons">
        {run?.status === "scanning" && <button className="btn" type="button" disabled={busy} onClick={() => void act("pause")}><Pause size={14} />暂停</button>}
        {run?.status === "paused" && <button className="btn primary" type="button" disabled={busy} onClick={() => void act("resume")}><Play size={14} />继续整理</button>}
        {run?.status === "ready" && changes.length > 0 && <button className="btn primary" type="button" disabled={busy} onClick={() => void act("apply")}><Check size={14} />应用 {changes.length} 项变更</button>}
        {run && ["ready", "paused"].includes(run.status) && <button className="btn" type="button" disabled={busy} onClick={() => void act("dismiss")}>放弃结果</button>}
        {run?.status === "applied" && <button className="btn" type="button" disabled={busy} onClick={() => void act("undo")}><RotateCcw size={14} />撤销整理</button>}
        {(!pending || (run?.status === "ready" && !run.proposals.length)) && <button className="btn primary" type="button" disabled={busy || activeCount === 0 || !window.api?.memory?.startOrganization} onClick={() => void act("start")}><Sparkles size={14} />{busy ? "处理中…" : "整理全部记忆"}</button>}
      </div>
    </div>
    <p className="memory-organization-description">自动覆盖全局、所有项目、工作空间和任务。合并重复、精简正文，保留来源与原有可见范围。</p>
    {run && !["dismissed", "undone"].includes(run.status) && <div className="memory-organization-progress">
      <div className="memory-organization-metrics" role="status"><span>已检查 <strong>{run.scanned}</strong> / {run.total}</span>
        <span>无需更改 {run.unchanged}</span><span>变更 {changes.length}</span><span>冲突 {conflicts.length}</span>
        {run.skipped > 0 && <span title="已归档或不在有效期内的记忆不会被改动">跳过 {run.skipped}</span>}
      </div>
      <progress aria-label="记忆整理进度" value={coverage} max={100} />
      {run.status === "ready" && changes.length > 0 && <p className="memory-organization-impact">应用后{removed >= 0 ? `减少 ${removed} 条重复或临时记忆` : `拆分出 ${-removed} 条独立事实`}，正文{run.afterChars <= run.beforeChars ? "减少" : "增加"} {Math.abs(run.beforeChars - run.afterChars).toLocaleString()} 字。冲突保持原样。</p>}
    </div>}
    {(error || run?.error) && <div className="memory-organization-error" role="alert"><AlertCircle size={15} /><span>{error || run?.error}</span></div>}
    {Boolean(run?.proposals.length) && <>
      <button type="button" className="memory-organization-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}{expanded ? "收起变更明细" : `查看 ${run!.proposals.length} 项变更与冲突`}</button>
      {expanded && <div className="memory-organization-proposals">{run!.proposals.map(proposal => <Proposal key={proposal.id} proposal={proposal} scopeName={scopeName} onOpen={onOpen} />)}</div>}
    </>}
  </section>;
}
