import { useEffect, useState } from "react";
import type { GoalActivityCost, GoalActivityDto } from "@shared/conversation-goal-activity";
import { SubagentSteerReceipts, useSubagentSteer } from "./SubagentSteerReceipts";
import "./GoalExecutionPanel.css";

const tokenLabels = { input: "新增输入", output: "输出", cacheRead: "缓存读取", cacheWrite: "缓存写入" } as const;
const usd = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 6 });
const exactTokens = new Intl.NumberFormat("zh-CN");

function tokenValue(value: number | null): string {
  return value == null ? "未知" : `${(value / 1_000_000).toFixed(3)} M · ${exactTokens.format(value)} tokens`;
}

function costValue(value: number | null): string {
  if (value == null) return "未知";
  if (value > 0 && value < 0.000001) return "< USD 0.000001";
  return usd.format(value);
}

function sourceCost(source: GoalActivityCost): string {
  if (!source.observedRequests && !source.missingGenerationObservations) return "暂无执行记录";
  return `${costValue(source.knownCostUsd)} · 供应商完整实报 ${source.providerReportedRequests}/${source.observedRequests} · Pi 估算 ${source.estimatedRequests} 个`;
}

function GoalCost({ activity }: { activity: GoalActivityDto }) {
  const unknownRequests = activity.observedRequests - activity.requestsWithCost;
  const complete = activity.observedRequests > 0 && unknownRequests === 0
    && activity.missingGenerationObservations === 0 && activity.unattributedAuxiliaryRequests === 0;
  const sources = Object.values(activity.costBySource);
  const reported = sources.reduce((sum, source) => sum + source.providerReportedRequests, 0);
  const estimated = sources.reduce((sum, source) => sum + source.estimatedRequests, 0);
  const label = complete && reported === activity.observedRequests ? "实报费用合计"
    : estimated ? "已知费用合计（含估算）" : "已知费用合计";
  return <section className="goal-execution-panel" aria-label="Goal 费用与用量">
    <h3>费用与用量</h3>
    <div className="goal-execution-cost"><span>{label}</span><strong>{costValue(activity.knownCostUsd)}</strong></div>
    <p>{activity.observedRequests
      ? `供应商完整实报 ${reported}/${activity.observedRequests} 个模型请求。Pi 按目录费率估算 ${estimated} 个。${unknownRequests ? ` ${unknownRequests} 个费用未知或不完整。` : ""}`
      : "暂无可归属的模型请求。"}
      {activity.missingGenerationObservations > 0 && ` 另有 ${activity.missingGenerationObservations} 次执行缺少请求观测。`}
    </p>
    <dl>
      <dt>主代理</dt><dd>{sourceCost(activity.costBySource.main)}</dd>
      <dt>子代理</dt><dd>{sourceCost(activity.costBySource.child)}</dd>
      <dt>辅助模型</dt><dd>{sourceCost(activity.costBySource.auxiliary)}</dd>
    </dl>
    <p>合计只包含可归属到本 Goal 的请求。
      {activity.unattributedAuxiliaryRequests > 0 && ` 关联任务还有 ${activity.unattributedAuxiliaryRequests} 个归属未知的辅助请求，未计入。`}
    </p>
    <details>
      <summary>Token 明细</summary>
      <dl>{(Object.keys(tokenLabels) as Array<keyof typeof tokenLabels>).map(field => <div key={field}>
        <dt>{tokenLabels[field]}</dt>
        <dd>{tokenValue(activity.knownTokens[field])}（{activity.tokenFieldCoverage[field]}/{activity.observedRequests} 个已观测请求）</dd>
      </div>)}</dl>
    </details>
  </section>;
}

type Child = { taskId: string; childId: string; name: string; model: string; returned?: string };
const keyOf = (child: Child) => JSON.stringify([child.taskId, child.childId]);
const returnedLabel: Record<string, string> = {
  completed: "已返回", failed: "失败", cancelled: "已取消", timedout: "已超时", blocked: "已阻止", skipped: "已跳过",
};

function childStatus(child: Child, running: boolean): string {
  return running ? "执行中" : child.returned ? returnedLabel[child.returned] ?? `已返回 · ${child.returned}` : "暂无返回记录";
}

function childrenForGoal(activity?: GoalActivityDto): Child[] {
  const children = new Map<string, Child>();
  for (const run of activity?.runs ?? []) {
    if (!run.child) continue;
    const child = { taskId: run.taskId, childId: run.child.id, name: run.child.displayName || run.child.role, model: run.child.model };
    const key = keyOf(child);
    children.set(key, { ...child, returned: run.returned?.status ?? children.get(key)?.returned });
  }
  return [...children.values()];
}

function GoalChildSteer({ child, running, onBack }: { child: Child; running: boolean; onBack: () => void }) {
  const { receipts, error, refresh, send, loaded } = useSubagentSteer(child.taskId, child.childId, running);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string>();
  const [sending, setSending] = useState(false);
  return <div className="goal-child-steer">
    <div className="goal-child-head"><strong>{child.name}</strong><button type="button" onClick={onBack}>返回 Goal</button></div>
    <p>{childStatus(child, running)} · {child.model}</p>
    {running && <form onSubmit={async event => {
      event.preventDefault();
      const text = draft.trim();
      if (!running || sending || !text) return;
      setSending(true);
      setNotice(undefined);
      try {
        const result = await send(text);
        if (result?.ok) setDraft("");
        else setNotice(result?.message ?? "暂时无法发送引导。");
      } catch (failure) {
        setNotice(failure instanceof Error ? failure.message : String(failure));
      } finally { setSending(false); }
    }}>
      <label>给{child.name}的引导<textarea value={draft} onChange={event => setDraft(event.target.value)} rows={2} disabled={!running} /></label>
      <button type="submit" disabled={!running || !draft.trim() || sending}>发送引导</button>
    </form>}
    {notice && <p role="alert">{notice}</p>}
    {!running && !error && receipts.length === 0 && <p>{loaded ? "暂无引导回执。" : "正在读取引导回执…"}</p>}
    <SubagentSteerReceipts receipts={receipts} error={error} refresh={refresh} />
  </div>;
}

export default function GoalExecutionPanel({ taskId, activity }: { taskId: string; activity?: GoalActivityDto }) {
  const children = childrenForGoal(activity);
  const taskScope = JSON.stringify([...new Set(children.map(child => child.taskId || taskId))].sort());
  const [live, setLive] = useState<{ scope: string; ids: Set<string>; failed: boolean }>();
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    if (!window.api?.subagent) return;
    const api = window.api.subagent;
    const tasks = JSON.parse(taskScope) as string[];
    if (!tasks.length) return;
    let current = true, reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const snapshots = await Promise.allSettled(tasks.map(id => api.active(id)));
        const ids = new Set<string>();
        snapshots.forEach((result, index) => {
          if (result.status === "fulfilled") for (const child of result.value) {
            if (child.status === "running") ids.add(JSON.stringify([tasks[index], child.subagentId]));
          }
        });
        if (current) setLive({ scope: taskScope, ids, failed: snapshots.some(result => result.status === "rejected") });
      } finally { reading = false; }
    };
    void refresh();
    const unsubscribe = api.onEvent?.(() => void refresh());
    const timer = setInterval(() => void refresh(), 1500);
    return () => { current = false; unsubscribe?.(); clearInterval(timer); };
  }, [taskScope]);
  const current = live?.scope === taskScope ? live : undefined;
  const isRunning = (child: Child) => Boolean(current?.ids.has(keyOf(child)));
  const ordered = [...children].sort((left, right) => Number(isRunning(right)) - Number(isRunning(left)));
  const child = children.find(candidate => keyOf(candidate) === selected);
  return <>
    {activity ? <GoalCost activity={activity} /> : <section className="goal-execution-panel" aria-label="Goal 费用与用量"><h3>费用与用量</h3><p>费用与用量未知。</p></section>}
    <section className="goal-execution-panel" aria-label="Goal 子代理">
      <h3>子代理</h3>
      {child ? <GoalChildSteer key={keyOf(child)} child={child} running={isRunning(child)} onBack={() => setSelected(undefined)} />
        : ordered.length ? <ul className="goal-child-list">{ordered.map(item => {
          const active = isRunning(item);
          const action = active ? "插话" : "查看引导回执";
          return <li key={keyOf(item)}>
            <span><strong>{item.name}</strong><small>{childStatus(item, active)} · {item.model}</small></span>
            <button type="button" aria-label={`${action} · ${item.name}`} onClick={() => setSelected(keyOf(item))}>{action}</button>
          </li>;
        })}</ul> : <p>暂无已关联的子代理。</p>}
      {current?.failed && <p role="status">无法刷新部分子代理的实时状态。</p>}
    </section>
  </>;
}
