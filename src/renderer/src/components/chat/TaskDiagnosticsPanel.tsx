import { useEffect, useState } from "react";
import type { ModelRequestDiagnostic, TaskDiagnosticsDto } from "@shared/task-diagnostics";
import "./TaskDiagnosticsPanel.css";

const sourceLabels = { main: "主代理", subagent: "子代理／会诊", auxiliary: "辅助任务" };
const statusLabels = { running: "执行中", completed: "完成", failed: "失败", aborted: "已停止", interrupted: "观测中断" };
const count = (value: number | null) => value === null ? "未知" : value.toLocaleString();
const duration = (value: number | null) => value === null ? "未知" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const money = (value: number | null, complete: boolean) => value === null ? "未知" : `${complete ? "" : "已知部分 "}$${value.toFixed(6)}`;
const time = (value: number) => new Date(value).toLocaleTimeString();
const changedLabels: Record<string, string> = { model: "模型", tools: "工具声明", instructions: "指令", system: "系统指令", reasoning: "推理设置", thinking: "思考设置" };

function RequestDetails({ request }: { request: ModelRequestDiagnostic }) {
  const prefix = request.cacheContext.prefixStable;
  return <details className="task-diagnostic-request" data-request-id={request.id}>
    <summary><span>{time(request.startedAt)} · {sourceLabels[request.sourceKind]} · {request.provider}/{request.model}</span>
      <span>{statusLabels[request.status]} · {duration(request.modelMs)}</span></summary>
    <div className="task-diagnostic-request-body">
      <dl className="task-diagnostic-identities">
        <dt>请求 ID</dt><dd><code>{request.id}</code></dd>
        <dt>执行身份</dt><dd><code>{request.executionScope} / 会话 {request.conversationId} / 调用 {request.generationTaskId}</code></dd>
        <dt>首个输出等待</dt><dd>{duration(request.firstResponseAt === null ? null : Math.max(0, request.firstResponseAt - request.startedAt))}</dd>
        <dt>结果</dt><dd>{request.outcome ?? "尚未完成"}{request.error ? `：${request.error}` : ""}</dd>
      </dl>
      <div className="task-diagnostic-table-wrap"><table><thead><tr><th>新输入 token</th><th>输出 token</th><th>缓存读取</th><th>缓存写入</th><th>估算费用</th></tr></thead>
        <tbody><tr><td>{count(request.usage.input)}</td><td>{count(request.usage.output)}</td><td>{count(request.usage.cacheRead)}</td><td>{count(request.usage.cacheWrite)}</td><td>{money(request.knownCostUsd, request.costComplete)}</td></tr></tbody></table></div>
      <p className="task-diagnostic-note">用量来源：{request.usageSource ? `供应商原始事件（${request.usageSource}）` : "未取得供应商原始用量"}。费用按模型目录单价估算，缺失字段不补零。</p>
      <p>历史前缀：{prefix === null ? "没有可比较的前次请求" : prefix ? "保持稳定" : "已变化"}。
        配置变化：{request.cacheContext.changedFields.length ? request.cacheContext.changedFields.map(field => changedLabels[field] ?? field).join("、") : "未观察到"}。
        观测覆盖：{request.cacheContext.coverage}。</p>
      {request.cacheContext.previousRequestId && <p className="task-diagnostic-note">前次请求：<code>{request.cacheContext.previousRequestId}</code></p>}
      {request.attempts.length ? <div className="task-diagnostic-table-wrap"><table><thead><tr><th>HTTP 尝试</th><th>发出时间</th><th>响应头耗时</th><th>状态</th></tr></thead>
        <tbody>{request.attempts.map(attempt => <tr key={attempt.number}><td>{attempt.number}{attempt.number > 1 ? "（重试）" : ""}</td><td>{time(attempt.startedAt)}</td>
          <td>{duration(attempt.finishedAt === null ? null : Math.max(0, attempt.finishedAt - attempt.startedAt))}</td><td>{attempt.httpStatus ?? "未知"}</td></tr>)}</tbody></table></div>
        : <p className="task-diagnostic-note">未观察到 HTTP 尝试记录。原生恢复后的新模型调用会显示为另一条请求，沿用执行身份。</p>}
    </div>
  </details>;
}

/** Pure view is exported so a desktop fixture can inspect the same product component. */
export function TaskDiagnosticsView({ value }: { value: TaskDiagnosticsDto }) {
  return <div data-testid="task-diagnostics-view">
    {value.unavailable && <p role="alert">{value.unavailable}</p>}
    <div className="task-diagnostic-totals">
      <div><span>本页模型观测累计</span><strong>{duration(value.totals.modelMs)}</strong></div>
      <div><span>本页工具观测累计</span><strong>{duration(value.totals.toolMs)}</strong></div>
      <div><span>等待回答／审批</span><strong>{duration(value.totals.waitingMs)}</strong></div>
      <div><span>目录单价估算</span><strong>{money(value.totals.knownCostUsd, value.totals.costComplete)}</strong></div>
    </div>
    <p className="task-diagnostic-note">模型时间含该请求的重试与传输。工具时间扣除同一调用的交互等待；并行和嵌套调用可能重叠，各项不能相加当任务总耗时。
      有 {value.totals.unknownUsageRequests} 条请求的用量不完整。累计仅含本页已观测区间，进程退出期间的未知耗时不补计。</p>
    <h4>模型请求 · {value.requests.length}</h4>
    {value.requests.length ? value.requests.map(request => <RequestDetails request={request} key={request.id} />) : <p className="task-diagnostic-note">尚无请求观测。历史回放不会伪造新的模型请求。</p>}
    <h4>工具调用 · {value.tools.length}</h4>
    {value.tools.length ? <div className="task-diagnostic-table-wrap"><table><thead><tr><th>工具／执行身份</th><th>来源</th><th>状态</th><th>执行观测</th><th>其中等待</th></tr></thead>
      <tbody>{value.tools.map(tool => <tr key={tool.id}><td>{tool.name}<small><code>{tool.id}</code></small>{tool.diagnostics.length > 0 && <small>{tool.diagnostics.join("、")}</small>}</td>
        <td>{sourceLabels[tool.sourceKind]}</td><td>{statusLabels[tool.status]}</td><td>{duration(!tool.complete && tool.observedMs === 0 ? null : tool.activeMs)}{tool.complete ? "" : "（不完整）"}</td><td>{duration(tool.waitingMs)}</td></tr>)}</tbody></table></div>
      : <p className="task-diagnostic-note">尚无工具观测。</p>}
    <h4>等待回答与审批 · {value.waits.length}</h4>
    {value.waits.length ? <div className="task-diagnostic-table-wrap"><table><thead><tr><th>交互</th><th>状态</th><th>等待时间</th></tr></thead><tbody>
      {value.waits.map(wait => <tr key={wait.id}><td>{wait.title}<small><code>{wait.executionId}</code></small></td><td>{wait.status === "pending" ? "等待回答" : wait.status === "resolved" ? "已回答" : "已结束"}</td>
        <td>{duration(Math.max(0, (wait.finishedAt ?? value.capturedAt) - wait.startedAt))}{wait.finishedAt === null ? "（仍在等待）" : ""}</td></tr>)}</tbody></table></div>
      : <p className="task-diagnostic-note">没有等待交互。</p>}
  </div>;
}

export default function TaskDiagnosticsPanel({ taskId }: { taskId: string | null }) {
  const [value, setValue] = useState<TaskDiagnosticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [taskId]);
  useEffect(() => {
    let alive = true;
    let loading = false;
    setValue(null); setError(null);
    if (!taskId) return;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await window.api?.agent?.getTaskDiagnostics?.(taskId, 200, offset);
        if (alive) { setValue(next ?? null); setError(next ? null : "诊断接口未就绪，请重新打开应用"); }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { loading = false; }
    };
    void refresh(); const timer = offset === 0 ? setInterval(() => void refresh(), 3000) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [taskId, offset]);
  return <section className="runtime-inspector-section task-diagnostics-panel" data-testid="task-diagnostics-panel">
    <div className="runtime-inspector-section-head"><h3>任务执行诊断</h3><span>{offset === 0 ? "只读 · 每 3 秒更新" : "只读 · 历史记录"}</span></div>
    {error && <p role="alert">{error}</p>}
    {value ? <TaskDiagnosticsView value={value} /> : <p className="task-diagnostic-note">{taskId ? "正在读取诊断记录…" : "选择任务后查看执行诊断"}</p>}
    {value && (offset > 0 || value.truncated) && <nav className="task-diagnostic-pages" aria-label="诊断记录分页">
      <button disabled={offset === 0} onClick={() => setOffset(previous => Math.max(0, previous - 200))}>较新记录</button>
      <span>第 {Math.floor(offset / 200) + 1} 页 · 每类最多 200 条</span>
      <button disabled={!value.truncated} onClick={() => setOffset(previous => previous + 200)}>更早记录</button>
    </nav>}
  </section>;
}
