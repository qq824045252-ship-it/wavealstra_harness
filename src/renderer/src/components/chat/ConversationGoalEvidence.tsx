import { useEffect, useState } from "react";
import type { ConversationGoalContinuationDto, ConversationGoalDto, ConversationGoalEvidenceDto } from "@shared/conversation-goal";
import { GOAL_CHECK_REASON, goalProgressFacts } from "./goalOverview";
import GoalArtifacts from "./GoalArtifacts";
import GoalExecutionPanel from "./GoalExecutionPanel";
import "./ConversationGoalEvidence.css";

const UNKNOWN = "未知";
const CHECK_TRIGGER = { settled: "执行结算", resumed: "恢复 Goal", continued: "手动继续" };
const DELIVERABLE_STATUS: Record<string, string> = {
  proposed: "已返回，待验收", accepted: "已接收", rejected: "已拒绝", superseded: "已被替代",
};

function formatTokens(tokens?: number | null): string {
  return tokens == null ? UNKNOWN : `${(tokens / 1_000_000).toFixed(3)} M`;
}

function resumeCondition(goal: ConversationGoalDto, continuation: ConversationGoalContinuationDto): string {
  if (goal.closedAt != null || goal.status === "achieved" || goal.status === "cancelled") return "Goal 已结束";
  if (goal.status === "paused") return "恢复 Goal 后重新检查";
  if (continuation.enabled === false) return "启用自动续跑后，等待新一轮结算或手动继续";
  if (continuation.state === "exhausted") return "手动继续会开启新的轮次和预算窗口";
  if (continuation.state === "deferred") return "在原对话提交新输入，或手动继续";
  return "执行结算后检查 Goal 状态、待输入、排队、运行、整理和续跑限额";
}

function Continuation({ goal }: { goal: ConversationGoalDto }): React.JSX.Element {
  const state = goal.continuation;
  const check = state?.lastCheck;
  const wake = state?.lastWake;
  const ended = goal.closedAt != null || goal.status === "achieved" || goal.status === "cancelled";
  const date = (at?: number) => at == null ? UNKNOWN : new Date(at).toLocaleString();
  return <section className="goal-evidence-section" aria-label="自动续跑">
    <h3>自动续跑</h3>
    {state ? <>
      <dl>
        <dt>最近唤醒</dt><dd>{wake ? `${date(wake.at)} · ${CHECK_TRIGGER[wake.trigger]}` : UNKNOWN}</dd>
        <dt>最近检查原因</dt><dd>{check ? GOAL_CHECK_REASON[check.reason] ?? UNKNOWN : UNKNOWN}</dd>
        {!ended && <><dt>停止原因</dt><dd>{state.deferReason ? GOAL_CHECK_REASON[state.deferReason] ?? UNKNOWN : "暂无停止记录"}</dd></>}
        <dt>恢复条件</dt><dd>{resumeCondition(goal, state)}</dd>
      </dl>
      <details><summary>续跑诊断</summary>
        <dl>
          <dt>全局开关</dt><dd>{state.enabled === undefined ? UNKNOWN : state.enabled ? "已启用" : "已关闭"}</dd>
          <dt>调度任务</dt><dd>{state.taskId ?? UNKNOWN}</dd>
          <dt>轮次</dt><dd>{state.attempts}/{state.maxAttempts}</dd>
          <dt>预算窗口计量</dt><dd>{state.taskId ? formatTokens(state.tokensUsed) : UNKNOWN} / {state.tokenBudget === null ? "不限" : formatTokens(state.tokenBudget)}</dd>
          <dt>停止时间</dt><dd>{date(state.lastStoppedAt)}</dd>
          {ended && state.deferReason && <><dt>历史停止原因</dt><dd>{GOAL_CHECK_REASON[state.deferReason] ?? UNKNOWN}</dd></>}
          <dt>最近检查时间</dt><dd>{check ? `${date(check.at)} · ${CHECK_TRIGGER[check.trigger]}` : UNKNOWN}</dd>
          <dt>连续无进展</dt><dd>{state.progressStalls != null && state.stallLimit != null ? `${state.progressStalls}/${state.stallLimit}` : UNKNOWN}</dd>
        </dl>
      </details>
    </> : <p>续跑状态未知</p>}
  </section>;
}

export default function ConversationGoalEvidence({ taskId, goal, onChanged, onProgress, children }: {
  taskId: string; goal: ConversationGoalDto; onChanged?: () => void;
  onProgress: (goalId: string, facts: string | null) => void; children?: React.ReactNode;
}): React.JSX.Element {
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ taskId: string; goalId: string; details?: ConversationGoalEvidenceDto; error?: string }>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const api = window.api?.conversationRuntime;
    if (!api) return;
    const refresh = async () => {
      try {
        const details = await api.goalEvidence(taskId, goal.id);
        if (active) {
          setLoaded({ taskId, goalId: goal.id, details });
          onProgress(goal.id, details ? goalProgressFacts(details) : null);
        }
      } catch {
        if (active) onProgress(goal.id, null);
        if (active) setLoaded(previous => ({ taskId, goalId: goal.id,
          details: previous?.taskId === taskId && previous.goalId === goal.id ? previous.details : undefined,
          error: "无法刷新 Goal 证据" }));
      } finally {
        if (active && !goal.closedAt) timer = setTimeout(() => void refresh(), 2500);
      }
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [taskId, goal.id, goal.version, goal.continuation?.lastCheck?.at, goal.closedAt, reload, onProgress]);
  const current = loaded?.taskId === taskId && loaded.goalId === goal.id ? loaded : undefined;
  const details = current?.details;
  const registeredFiles = new Map<string, { path: string; digest?: string }>();
  const workflowEvidence = (details?.activity?.nativeEvidence ?? []).filter(record => {
    if (record.kind !== "delivery" || !record.path || record.url) return true;
    registeredFiles.set(JSON.stringify([record.path, record.digest]), { path: record.path, digest: record.digest });
    return false;
  });
  const verified = details?.verification.filter(item => goal.criteria.some(criterion => criterion.id === item.criterionId));
  const requiredCount = goal.criteria.filter(criterion => criterion.status !== "waived").length;
  const refresh = (): void => {
    setReload(value => value + 1);
    onChanged?.();
  };
  return <div className="goal-evidence">
    {current?.error && <p role="alert">{current.error} <button type="button" onClick={refresh}>重试</button></p>}
    <GoalArtifacts taskId={taskId} goalId={goal.id} artifacts={details?.savedArtifacts}
      loading={!current} onVerified={refresh} />
    <GoalExecutionPanel taskId={taskId} activity={details?.activity} />
    <Continuation goal={goal} />
    {children}
    <details className="goal-evidence-section">
      <summary>执行归属与诊断</summary>
      <button type="button" onClick={refresh}>刷新证据</button>
      <dl>
        <dt>Goal ID</dt><dd>{goal.id}</dd>
        <dt>所属 Bot</dt><dd>{details?.ownerBotId ?? UNKNOWN}</dd>
        <dt>用户 ID</dt><dd>{details?.userId ?? UNKNOWN}</dd>
        <dt>当前任务</dt><dd>{taskId}</dd>
        <dt>目标版本</dt><dd>{details?.intentRevision ?? UNKNOWN}</dd>
        <dt>输入快照</dt><dd>{details?.inputSnapshotId ?? UNKNOWN}</dd>
      </dl>
      {details?.activity && <ActivityRuns activity={details.activity} />}
      {details?.executions.length ? <ul>{details.executions.map(execution => {
        const usage = execution.metrics;
        return <li key={execution.bindingId}>
          <strong>{execution.status} · {execution.botId}</strong>
          <dl>
            <dt>执行 ID</dt><dd>{execution.bindingId}</dd>
            <dt>执行任务</dt><dd>{execution.taskId}</dd>
            <dt>执行会话</dt><dd>{execution.conversationId}</dd>
            <dt>总输入</dt><dd>{formatTokens(usage?.totalInputTokens)}</dd>
            <dt>输入</dt><dd>{formatTokens(usage?.inputTokens)}</dd>
            <dt>输出</dt><dd>{formatTokens(usage?.outputTokens)}</dd>
            <dt>缓存读 / 写</dt><dd>{formatTokens(usage?.cacheReadTokens)} / {formatTokens(usage?.cacheWriteTokens)}</dd>
            <dt>用量覆盖率</dt><dd>{usage?.calls ? `${(usage.reportedCalls / usage.calls * 100).toFixed(3)}%（${usage.reportedCalls}/${usage.calls}）` : UNKNOWN}</dd>
          </dl>
        </li>;
      })}</ul> : !details?.activity && <p>{details ? "暂无可归属的执行记录。Provider 用量和覆盖率未知。" : "执行记录未知"}</p>}
    </details>
    <details className="goal-evidence-section">
      <summary>返回记录与验收证据</summary>
      <p>Work 已提交交付物 {details ? details.deliverables.length : UNKNOWN} · 原生已登记文件版本 {details?.activity ? registeredFiles.size : UNKNOWN}</p>
      <p>已验证验收项 {verified ? `${verified.length}/${requiredCount}` : UNKNOWN}</p>
      {details?.deliverables.length ? <ul>{details.deliverables.map(deliverable => <li key={deliverable.deliverableId}>
        <strong>{DELIVERABLE_STATUS[deliverable.status] ?? deliverable.status}</strong>
        <p>{deliverable.summary || UNKNOWN}</p>
        {deliverable.artifactRefs.length > 0 && <ul>{deliverable.artifactRefs.map((ref, index) => <li key={index}>{ref}</li>)}</ul>}
      </li>)}</ul> : null}
      {verified?.length ? <ul>{verified.map(item => <li key={item.criterionId}>
        <strong>{goal.criteria.find(criterion => criterion.id === item.criterionId)?.text}</strong>
        {item.evidence.map(evidence => <dl key={evidence.evidenceId}>
          <dt>验证来源</dt><dd>{evidence.provenance === "user" ? "用户" : "系统"} · {evidence.sourceRef}</dd>
          <dt>源码 SHA</dt><dd>{evidence.sourceSha ?? UNKNOWN}</dd>
          <dt>验证环境</dt><dd>{evidence.environment ?? UNKNOWN}</dd>
          {evidence.detail && <><dt>证据</dt><dd>{evidence.detail}</dd></>}
        </dl>)}
      </li>)}</ul> : null}
      {details?.artifacts.length ? <><h4>Work 交付物指纹</h4><ul>{details.artifacts.map(artifact => <li key={`${artifact.bindingId}:${artifact.path}`}>
        <div>{artifact.path}</div><code>{artifact.sha256 ? `SHA-256 ${artifact.sha256}` : UNKNOWN}</code>
      </li>)}</ul></> : null}
      {registeredFiles.size > 0 && <><h4>原生文件登记</h4><ul>{[...registeredFiles].map(([key, file]) => <li key={key}>
        <div>{file.path}</div><div>文件摘要 <code>{file.digest ? `SHA-256 ${file.digest}` : UNKNOWN}</code></div>
      </li>)}</ul></>}
    </details>
    {workflowEvidence.length ? <NativeEvidence records={workflowEvidence} /> : null}
    {details?.schedules?.length ? <details className="goal-evidence-section">
      <summary>已登记的检查日程</summary>
      <ul>{details.schedules.map(schedule => <li key={schedule.subscriptionId}>
        <strong>{schedule.source}</strong>
        <dl>
          <dt>最近检查</dt><dd>{schedule.lastCheckedAt == null ? UNKNOWN : new Date(schedule.lastCheckedAt).toLocaleString()}</dd>
          <dt>下次唤醒</dt><dd>{schedule.stoppedAt != null ? "已停止" : schedule.nextWakeAt == null ? UNKNOWN : new Date(schedule.nextWakeAt).toLocaleString()}</dd>
          {schedule.stoppedReason && <><dt>停止原因</dt><dd>{schedule.stoppedReason}</dd></>}
        </dl>
      </li>)}</ul>
    </details> : null}
    {goal.status === "achieved" && <LearnedSkills skills={details?.activity?.skills} />}
  </div>;
}

function ActivityRuns({ activity }: { activity: NonNullable<ConversationGoalEvidenceDto["activity"]> }): React.JSX.Element {
  const { runs } = activity;
  return <>
    {runs.length > 0 && <ul>{runs.map(run => <li key={JSON.stringify([run.taskId, run.conversationId, run.generationTaskId])}>
      <strong>{run.child ? `子代理 · ${run.child.displayName || run.child.role}` : "主代理"}</strong>
      <dl>
        <dt>模型执行状态</dt><dd>{run.status ?? UNKNOWN}</dd>
        {run.child && <><dt>子代理返回</dt><dd>{run.returned ? `${run.returned.status} · ${run.returned.toolCallId}` : "暂无可归属的返回回执"}</dd></>}
        <dt>执行身份</dt><dd>{run.taskId} / {run.conversationId} / {run.generationTaskId}</dd>
        <dt>目标版本</dt><dd>{run.intentRevision}</dd>
        {run.parent && <><dt>父执行</dt><dd>{run.parent.conversationId} / {run.parent.generationTaskId}</dd></>}
        <dt>请求 / 重试</dt><dd>{run.requestCount} / {run.retryCount}</dd>
      </dl>
    </li>)}</ul>}
  </>;
}


type GoalActivity = NonNullable<ConversationGoalEvidenceDto["activity"]>;

function NativeEvidence({ records }: { records: NonNullable<GoalActivity["nativeEvidence"]> }): React.JSX.Element {
  const state = { running: "执行中", returned: "已返回", verified: "已核验", failed: "失败" };
  return <details className="goal-evidence-section">
    <summary>工作流验证与交付</summary>
    <ul>{records.map((record, index) => <li key={JSON.stringify([record.taskId, record.conversationId, record.toolTaskId, index])}>
      <strong>{record.kind === "unit" ? `${record.unitId} · ${state[record.state]}`
        : record.kind === "check" ? record.passed ? "检查通过" : "检查未通过" : "交付物"}</strong>
      <dl>
        <dt>执行与目标版本</dt><dd>{record.conversationId} / {record.generationTaskId} · {record.intentRevision}</dd>
        {"boardRun" in record && record.boardRun != null && <><dt>工作流运行</dt><dd>{record.boardRun}</dd></>}
        {"command" in record && record.command && <><dt>核验命令</dt><dd><code>{record.command}</code></dd></>}
        {record.kind === "check" && <><dt>退出码</dt><dd>{record.exitCode ?? UNKNOWN}</dd></>}
        {"sha" in record && record.sha && <><dt>提交 SHA</dt><dd><code>{record.sha}</code></dd></>}
        {"branch" in record && record.branch && <><dt>分支</dt><dd>{record.branch}</dd></>}
        {"reason" in record && record.reason && <><dt>结论依据</dt><dd>{record.reason}</dd></>}
        {"pr" in record && record.pr != null && <><dt>PR</dt><dd>#{record.pr}</dd></>}
        {record.kind !== "delivery" && record.fingerprint && <><dt>工作区指纹</dt><dd><code>{record.fingerprint}</code></dd></>}
        {record.kind === "delivery" && record.digest && <><dt>{record.url ? "PR 正文摘要" : "文件摘要"}</dt><dd><code>{record.digest}</code></dd></>}
        {record.kind === "delivery" && <><dt>位置</dt><dd>{record.path || record.url || UNKNOWN}</dd></>}
      </dl>
    </li>)}</ul>
  </details>;
}

function LearnedSkills({ skills }: { skills?: GoalActivity["skills"] }): React.JSX.Element {
  return <details className="goal-evidence-section">
    <summary>可复用的 Skill</summary>
    {skills?.length ? <ul>{skills.map((skill, index) => <li key={JSON.stringify([skill.skillId, skill.creationToolCallId, skill.assistantMessageId, index])}>
      <strong>{skill.skillId}</strong>
      {skill.description && <p>{skill.description}</p>}
      <dl>
        <dt>安装版本</dt><dd>{skill.installedVersion ?? UNKNOWN}</dd>
        {skill.installedFingerprint && <><dt>内容指纹</dt><dd><code>{skill.installedFingerprint}</code></dd></>}
        {skill.candidateId && <><dt>学习候选</dt><dd>{skill.candidateId}</dd></>}
        {skill.sourceMemoryIds.length > 0 && <><dt>来源记忆</dt><dd>{skill.sourceMemoryIds.join(" · ")}</dd></>}
        {skill.creationToolCallId && <><dt>创建回执</dt><dd>{skill.creationToolCallId}</dd></>}
        {skill.scopeType && <><dt>适用范围</dt><dd>{skill.scopeType}{skill.scopeId ? ` · ${skill.scopeId}` : ""}</dd></>}
        <dt>本目标内调用</dt><dd>{skill.invokedAt != null ? `${new Date(skill.invokedAt).toLocaleString()} · ${skill.invocationKind ?? UNKNOWN}` : "暂无可归属的调用回执"}</dd>
        {skill.assistantMessageId && <><dt>调用回合</dt><dd>{skill.assistantMessageId}</dd></>}
        <dt>后续复用</dt><dd>{skill.laterInvokedAt != null ? new Date(skill.laterInvokedAt).toLocaleString() : "暂无可归属的调用回执"}</dd>
      </dl>
    </li>)}</ul> : <p>暂无可归属的创建或调用回执。</p>}
  </details>;
}
