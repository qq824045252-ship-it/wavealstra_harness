import { useEffect, useMemo, useState } from "react";
import type { ModelRequestDiagnostic, TaskDiagnosticsDto, ToolDiagnostic } from "@shared/task-diagnostics";
import { buildDiagnosticsReport, cacheLine, type Finding, type TurnDiagnostics, type Verdict } from "@/lib/diagnosticsRules";
import "./TaskDiagnosticsPanel.css";

const sourceLabels = { main: "主代理", subagent: "子代理／会诊", auxiliary: "辅助任务" };
const costLabels = { "provider-reported": "供应商报告", "pi-native": "Pi 原生计价", "sdk-default": "未取得费用（SDK 初始值）" };
const statusLabels = { running: "执行中", completed: "完成", failed: "失败", aborted: "已停止", interrupted: "观测中断" };
const verdictLabels: Record<Verdict, string> = { ok: "正常", warn: "需注意", error: "异常", unknown: "无法判断", waiting: "在等人" };
const verdictIcons: Record<Verdict, string> = { ok: "✓", warn: "!", error: "✕", unknown: "?", waiting: "…" };
const count = (value: number | null) => value === null ? "未知" : value.toLocaleString();
const duration = (value: number | null) => value === null ? "未知" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const money = (value: number | null, complete: boolean) => value === null ? "未知" : `${complete ? "" : "已知部分 "}$${value.toFixed(6)}`;
const time = (value: number) => new Date(value).toLocaleTimeString();
const changedLabels: Record<string, string> = { model: "模型", tools: "工具声明", instructions: "指令", system: "系统指令", reasoning: "推理设置", thinking: "思考设置" };

function VerdictBadge({ verdict, small = false }: { verdict: Verdict; small?: boolean }): React.JSX.Element {
  return (
    <span className={`td-verdict td-verdict--${verdict}${small ? " td-verdict--small" : ""}`} data-verdict={verdict}>
      <span aria-hidden>{verdictIcons[verdict]}</span>
      {verdictLabels[verdict]}
    </span>
  );
}

function FindingRow({ finding }: { finding: Finding }): React.JSX.Element {
  return (
    <li className={`td-finding td-finding--${finding.verdict}`}>
      <VerdictBadge verdict={finding.verdict} small />
      <div className="td-finding-body">
        <div className="td-finding-title">
          <span className="td-rule">{finding.ruleId}</span>
          {finding.title}
        </div>
        <div className="td-finding-evidence">{finding.evidence}</div>
        <div className="td-finding-basis">{finding.basis}</div>
      </div>
    </li>
  );
}

function RequestDetails({ request }: { request: ModelRequestDiagnostic }) {
  const prefix = request.cacheContext.prefixStable;
  return <details className="task-diagnostic-request" data-request-id={request.id}>
    <summary><span>{time(request.startedAt)} · {sourceLabels[request.sourceKind]} · {request.provider}/{request.model}</span>
      <span>{statusLabels[request.status]} · {duration(request.modelMs)}</span></summary>
    <div className="task-diagnostic-request-body">
      <dl className="task-diagnostic-identities">
        <dt>请求 ID</dt><dd><code>{request.id}</code></dd>
        <dt>轮次身份</dt><dd><code>{request.executionId}</code></dd>
        <dt>执行身份</dt><dd><code>{request.executionScope} / 会话 {request.conversationId} / 调用 {request.generationTaskId}</code></dd>
        <dt>首个输出等待</dt><dd>{duration(request.firstResponseAt === null ? null : Math.max(0, request.firstResponseAt - request.startedAt))}</dd>
        <dt>结果</dt><dd>{request.outcome ?? "尚未完成"}{request.error ? `：${request.error}` : ""}</dd>
      </dl>
      <div className="task-diagnostic-table-wrap"><table><thead><tr><th>新输入 token</th><th>输出 token</th><th>缓存读取</th><th>缓存写入</th><th>费用</th></tr></thead>
        <tbody><tr><td>{count(request.usage.input)}</td><td>{count(request.usage.output)}</td><td>{count(request.usage.cacheRead)}</td><td>{count(request.usage.cacheWrite)}</td><td>{money(request.knownCostUsd, request.costComplete)}</td></tr></tbody></table></div>
      <p className="task-diagnostic-note">用量来源：{request.usageSource ? `供应商原始事件（${request.usageSource}）` : "未取得供应商原始用量"}。费用来源：{request.costSource ? costLabels[request.costSource] : "未知"}，缺失字段不补零。</p>
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

function ToolTable({ tools }: { tools: ToolDiagnostic[] }): React.JSX.Element {
  return <div className="task-diagnostic-table-wrap"><table><thead><tr><th>工具／执行身份</th><th>来源</th><th>状态</th><th>执行观测</th><th>其中等待</th></tr></thead>
    <tbody>{tools.map(tool => <tr key={tool.id}><td>{tool.name}<small><code>{tool.id}</code></small>{tool.diagnostics.length > 0 && <small>{tool.diagnostics.join("、")}</small>}</td>
      <td>{sourceLabels[tool.sourceKind]}</td><td>{statusLabels[tool.status]}</td><td>{duration(!tool.complete && tool.observedMs === 0 ? null : tool.activeMs)}{tool.complete ? "" : "（不完整）"}</td><td>{duration(tool.waitingMs)}</td></tr>)}</tbody></table></div>;
}

function TurnCard({ turn }: { turn: TurnDiagnostics }): React.JSX.Element {
  const [open, setOpen] = useState(turn.verdict === "error" || turn.verdict === "warn");
  const retries = turn.requests.reduce((sum, request) => sum + Math.max(0, request.attempts.length - 1), 0);
  const failedTools = turn.tools.filter((tool) => tool.status === "failed").length;
  const delta = turn.hitRateDeltaPct;
  return <section className={`td-turn td-turn--${turn.verdict}`} data-turn-key={turn.key} data-verdict={turn.verdict}>
    <header className="td-turn-head">
      <VerdictBadge verdict={turn.verdict} />
      <span className="td-turn-label">{turn.label}</span>
      <span className="td-turn-time">{time(turn.startedAt)}</span>
      <span className="td-turn-source">{sourceLabels[turn.sourceKind]}</span>
      <span className="td-turn-duration">{duration(turn.endedAt === null ? null : Math.max(0, turn.endedAt - turn.startedAt))}</span>
      <button type="button" className="td-turn-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "收起详情" : "展开详情"}
      </button>
    </header>

    {/* 缓存：用户最关心的口径，单独一行，永远是加权计算 */}
    <div className="td-cache" data-testid="turn-cache">
      <span className="td-cache-rate">{turn.cache.hitRate === null ? "缓存命中 —" : `缓存命中 ${Math.round(turn.cache.hitRate * 100)}%`}</span>
      <span className="td-cache-detail">{cacheLine(turn.cache).replace(/^缓存命中 [^·]+ · /, "")}</span>
      {delta !== null && (
        <span className={`td-cache-delta ${delta < 0 ? "is-down" : delta > 0 ? "is-up" : ""}`} title={`上一轮 ${turn.previousHitRate === null ? "未知" : `${Math.round(turn.previousHitRate * 100)}%`}`}>
          {delta > 0 ? "+" : ""}{delta}pp
        </span>
      )}
    </div>

    <div className="td-metrics">
      <span>模型 {turn.requests.length} 次{retries > 0 ? `（重试 ${retries}）` : ""}</span>
      <span>工具 {turn.tools.length} 个{failedTools > 0 ? `（失败 ${failedTools}）` : ""}</span>
      <span>首字 {duration(turn.firstTokenMs)}</span>
      <span>{turn.outputTps === null ? "速率 未知" : `${turn.outputTps.toFixed(1)} tok/s`}</span>
      <span>{turn.costUsd === null ? "费用 未知" : `费用 ${money(turn.costUsd, turn.costComplete)}`}</span>
      <span>模型耗时 {duration(turn.modelMs)}</span>
      <span>等待 {duration(turn.waitingMs)}{turn.approximateWaits ? "（估算归属）" : ""}</span>
    </div>

    {open && (
      <div className="td-turn-body">
        <div className="td-turn-section-title">判定依据 · {turn.findings.length}</div>
        {turn.findings.length > 0
          ? <ul className="td-findings">{turn.findings.map((finding, index) => <FindingRow key={`${finding.ruleId}-${index}`} finding={finding} />)}</ul>
          : <p className="task-diagnostic-note">本轮没有触发任何规则。</p>}

        <div className="td-turn-section-title">模型请求 · {turn.requests.length}</div>
        {turn.requests.length > 0
          ? turn.requests.map((request) => <RequestDetails request={request} key={request.id} />)
          : <p className="task-diagnostic-note">本轮没有模型请求记录。</p>}

        <div className="td-turn-section-title">工具调用 · {turn.tools.length}</div>
        {turn.tools.length > 0 ? <ToolTable tools={turn.tools} /> : <p className="task-diagnostic-note">本轮没有工具记录。</p>}

        {turn.waits.length > 0 && <>
          <div className="td-turn-section-title">等待回答与审批 · {turn.waits.length}</div>
          <div className="task-diagnostic-table-wrap"><table><thead><tr><th>交互</th><th>状态</th><th>等待时间</th></tr></thead><tbody>
            {turn.waits.map((wait) => <tr key={wait.id}><td>{wait.title}<small><code>{wait.executionId}</code></small></td>
              <td>{wait.status === "pending" ? "等待回答" : wait.status === "resolved" ? "已回答" : "已结束"}</td>
              <td>{duration(Math.max(0, (wait.finishedAt ?? turn.endedAt ?? turn.startedAt) - wait.startedAt))}{wait.finishedAt === null ? "（仍在等待）" : ""}</td></tr>)}
          </tbody></table></div>
        </>}
      </div>
    )}
  </section>;
}

type Filter = "all" | Verdict;

/** Pure view is exported so a desktop fixture can inspect the same product component. */
export function TaskDiagnosticsView({ value, now = Date.now() }: { value: TaskDiagnosticsDto; now?: number }) {
  const report = useMemo(() => buildDiagnosticsReport(value, now), [value, now]);
  const [filter, setFilter] = useState<Filter>("all");
  const [showRules, setShowRules] = useState(false);
  const turns = filter === "all" ? report.turns : report.turns.filter((turn) => turn.verdict === filter);
  const visible = [...turns].sort((a, b) => b.startedAt - a.startedAt);
  const filterOrder: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: "全部", count: report.turns.length },
    { key: "error", label: "异常", count: report.summary.error },
    { key: "warn", label: "需注意", count: report.summary.warn },
    { key: "unknown", label: "无法判断", count: report.summary.unknown },
    { key: "waiting", label: "在等人", count: report.summary.waiting },
    { key: "ok", label: "正常", count: report.summary.ok },
  ];

  return <div data-testid="task-diagnostics-view">
    {value.unavailable && <p role="alert">{value.unavailable}</p>}

    <div className={`td-summary td-summary--${report.summary.error > 0 ? "error" : report.summary.warn > 0 ? "warn" : report.summary.unknown > 0 ? "unknown" : "ok"}`}>
      <div className="td-summary-headline" data-testid="diagnostics-headline">{report.headline}</div>
      <div className="td-summary-counts">
        {(["error", "warn", "unknown", "waiting"] as const).map((key) => (
          <span key={key} className={`td-count td-count--${key}`}>
            {verdictLabels[key]} {report.summary[key]}
          </span>
        ))}
        <span className="td-count">共 {report.turns.length} 轮 · {report.totals.requests} 请求 · {report.totals.tools} 工具</span>
      </div>
      <p className="task-diagnostic-note">
        判定只基于观测到的事实：失败/重试/HTTP 错误/工具失败为硬规则；首字与速率的阈值是同任务同模型的历史分位（首字 {report.baseline.firstToken.p90 === null ? "样本不足" : `p90 ${duration(report.baseline.firstToken.p90)}`} · 速率 {report.baseline.tps.p10 === null ? "样本不足" : `p10 ${report.baseline.tps.p10.toFixed(1)} tok/s`}）。
        缺数据一律标「无法判断」，不按 0 补。累计只含本任务全量观测（不再按 200 条截断）。
      </p>
    </div>

    <div className="td-filter" role="group" aria-label="按判定筛选">
      {filterOrder.map((item) => (
        <button key={item.key} type="button" className={`td-filter-btn${filter === item.key ? " is-active" : ""}`}
          aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
          {item.label} {item.count}
        </button>
      ))}
      <button type="button" className={`td-filter-btn${showRules ? " is-active" : ""}`} aria-pressed={showRules} onClick={() => setShowRules((value) => !value)}>
        规则说明
      </button>
    </div>

    {showRules && <ul className="td-rules">
      {report.rules.map((rule) => <li key={rule.ruleId}><span className="td-rule">{rule.ruleId}</span>{rule.text}</li>)}
    </ul>}

    {visible.length > 0
      ? visible.map((turn) => <TurnCard turn={turn} key={turn.key} />)
      : <p className="task-diagnostic-note">{report.turns.length === 0 ? "尚无观测记录。历史回放不会伪造新的请求。" : `没有「${verdictLabels[filter as Verdict] ?? "该判定"}」的轮次。`}</p>}
  </div>;
}

export default function TaskDiagnosticsPanel({ taskId }: { taskId: string | null }) {
  const [value, setValue] = useState<TaskDiagnosticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { setValue(null); setError(null); }, [taskId]);
  const live = Boolean(value && (value.requests.some((row) => row.status === "running")
    || value.tools.some((row) => row.status === "running") || value.waits.some((row) => row.status === "pending")));
  // 全量读取（不再分页/截断）：规则与基线需要整段观测
  useEffect(() => {
    let alive = true;
    let loading = false;
    if (!taskId) return;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await window.api?.agent?.getTaskDiagnostics?.(taskId);
        if (alive) { setValue(next ?? null); setError(next ? null : "诊断接口未就绪，请重新打开应用"); }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { loading = false; }
    };
    void refresh();
    // 只在还有「进行中」的读数时轮询；历史不变就不重复拉全量
    const timer = live ? setInterval(() => void refresh(), 3000) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [taskId, tick, live]);
  return <section className="runtime-inspector-section task-diagnostics-panel" data-testid="task-diagnostics-panel">
    <div className="runtime-inspector-section-head">
      <h3>任务执行诊断</h3>
      <span>只读{value && (value.requests.some((row) => row.status === "running") || value.waits.some((row) => row.status === "pending")) ? " · 每 3 秒更新" : ""}</span>
      <button type="button" className="td-refresh" onClick={() => setTick((value) => value + 1)}>刷新</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {value ? <TaskDiagnosticsView value={value} /> : <p className="task-diagnostic-note">{taskId ? "正在读取诊断记录…" : "选择任务后查看执行诊断"}</p>}
  </section>;
}
