import { useEffect, useState } from "react";
import { IconDiagnostics } from "@/components/common/icons";
import { ExecutionDiagnosticsDialog } from "@/components/chat/TaskDiagnosticsDialog";
import type { BotExecutionDiagnosticsDto, BotExecutionDiagnosticsRequest } from "@shared/bot-execution-diagnostics";
import { TaskDiagnosticsView } from "@/components/chat/TaskDiagnosticsPanel";
import "./BotExecutionDiagnostics.css";

export function BotExecutionDiagnosticsButton({ request, iconOnly = false }: { request: BotExecutionDiagnosticsRequest; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const identity = JSON.stringify(request);
  useEffect(() => setOpen(false), [identity]);
  return <><button type="button" className={iconOnly ? "bot-icon-button" : "bot-quiet-button"} title="执行诊断" aria-label="执行诊断" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{iconOnly ? <IconDiagnostics size={18} /> : "执行诊断"}</button>
    {open && <BotExecutionDiagnosticsDialog request={request} onClose={() => setOpen(false)} />}</>;
}

export function BotExecutionDiagnosticsDialog({ request, onClose }: { request: BotExecutionDiagnosticsRequest; onClose: () => void }) {
  const [value, setValue] = useState<BotExecutionDiagnosticsDto>();
  const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState(request.kind === "foreground" ? request.conversationId : undefined);
  const [groupId, setGroupId] = useState("");
  const [refresh, setRefresh] = useState(0);
  const identity = JSON.stringify(request);
  useEffect(() => {
    let alive = true, loading = false;
    setValue(undefined); setError("");
    const load = async () => {
      if (loading) return; loading = true;
      try {
        const input = request.kind === "foreground" ? { ...request, conversationId } : request;
        if (!window.api?.botWork.executionDiagnostics) throw new Error("诊断接口尚未就绪，请更新后重新打开");
        const next = await window.api.botWork.executionDiagnostics(input);
        if (alive) { setValue(next); setError(""); }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [identity, conversationId, refresh]);
  const selected = value?.groups.find(group => group.id === groupId) ?? value?.groups[0];
  return <ExecutionDiagnosticsDialog title={request.kind === "work" ? "事项执行诊断" : "前台执行诊断"} subtitle="每个对话、执行和成员分别查看；复用普通任务诊断。" onClose={onClose}>
        <p>{value?.note ?? "读取实际诊断记录，不重新执行任务。"}</p>
        <div className="bot-execution-diagnostics-selectors">
          {request.kind === "foreground" && value && <label><span>对话</span> <select aria-label="诊断对话" value={value.conversationId ?? ""} onChange={event => { setConversationId(event.target.value); setGroupId(""); }}>
            {value.conversations.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
          </select></label>}
          {request.kind === "work" && value && <label><span>执行/成员</span> <select aria-label="诊断执行" value={selected?.id ?? ""} onChange={event => setGroupId(event.target.value)}>
            {value.groups.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
          </select></label>}
          <button type="button" className="bot-quiet-button" onClick={() => setRefresh(value => value + 1)}>刷新</button>
        </div>
        {error && <p role="alert">{error}</p>}
        {selected ? <TaskDiagnosticsView key={selected.id} value={selected.value} /> : <p>{value ? "暂无执行诊断。旧记录没有采集的数据不会补成零。" : "正在读取…"}</p>}
  </ExecutionDiagnosticsDialog>;
}
