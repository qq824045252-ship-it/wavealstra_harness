import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationGoalDto, ConversationGoalUpdateRequest, ConversationGoalVersionWitness } from "@shared/conversation-goal";
import { IconTarget } from "@/components/common/icons";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import { latestConversationGoal } from "@/utils/conversationGoal";
import ConversationGoalEvidence from "./ConversationGoalEvidence";
import { goalContinuationSummary, goalProgressFacts, goalWaitingSummary } from "./goalOverview";

const STATUS_LABEL: Record<ConversationGoalDto["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "等待处理",
  achieved: "已完成",
  cancelled: "已取消",
};
const CRITERION_LABEL: Record<ConversationGoalDto["criteria"][number]["status"], string> = {
  met: "已满足",
  waived: "已豁免",
  pending: "待验收",
  not_met: "未满足",
};

function statusLabel(goal: ConversationGoalDto): string {
  return goal.closureConclusion === "ended_unsuccessfully" ? "未达成并结束" : STATUS_LABEL[goal.status];
}

function progressText(goal: ConversationGoalDto, observedFacts?: string | null): string {
  const met = goal.criteria.filter(item => item.status === "met").length;
  const parts = [goal.progressSummary?.trim(), observedFacts?.trim(), met ? `已满足 ${met} 项验收条件` : undefined].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return observedFacts === undefined ? "正在读取进展…" : observedFacts === null ? "进展暂不可读" : "暂无进展记录";
}

function mergeGoals(current: ConversationGoalDto[], incoming: readonly ConversationGoalDto[]): ConversationGoalDto[] {
  const goals = new Map(current.map(goal => [goal.id, goal]));
  let changed = false;
  for (const goal of incoming) {
    const previous = goals.get(goal.id);
    const latest = latestConversationGoal(previous, goal);
    if (latest !== previous) { goals.set(goal.id, latest); changed = true; }
  }
  return changed ? [...goals.values()] : current;
}

function goalWitness(goal: ConversationGoalDto): ConversationGoalVersionWitness {
  return { expectedVersion: goal.version, expectedIntentRevision: goal.intentRevision, expectedOwnerEpoch: goal.ownerEpoch };
}

function budgetOverride(goal?: ConversationGoalDto): number | null {
  const continuation = goal?.continuation;
  return continuation?.tokenBudgetOverride !== undefined ? continuation.tokenBudgetOverride : continuation?.tokenBudget ?? null;
}

export default function ConversationGoalChip({ taskId, goal: latestGoal, viewGoal }: {
  taskId: string;
  goal?: ConversationGoalDto;
  viewGoal?: ConversationGoalDto;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>();
  const [goals, setGoals] = useState<ConversationGoalDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [progressFacts, setProgressFacts] = useState<Record<string, string | null>>({});
  const readListVersions = useRef(new Map<string, string>());
  const visibleGoals = useMemo(() => mergeGoals(goals, [latestGoal, viewGoal].filter((item): item is ConversationGoalDto => item?.taskId === taskId)),
    [goals, latestGoal, viewGoal, taskId]);
  const projectedGoal = visibleGoals.reduce<ConversationGoalDto | undefined>(latestConversationGoal, latestGoal);
  const activeGoal = projectedGoal?.closedAt === undefined ? projectedGoal : undefined;
  const selectedId = selected === undefined ? activeGoal?.id ?? visibleGoals[0]?.id : selected;
  const goal = visibleGoals.find(item => item.id === selectedId);
  const readOnly = Boolean(goal?.closedAt || goal?.status === "achieved" || goal?.status === "cancelled");
  const [editing, setEditing] = useState(false);
  const showForm = !readOnly && (!goal || editing);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [progress, setProgress] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Seed the form only when the dialog opens (or the edited Goal changes).
   * A host continuation patch updates the goal prop while the user is typing;
   * resetting every field on each patch would discard their edits. */
  const seeded = useRef<{ goal?: ConversationGoalDto } | null>(null);
  const recordProgress = useCallback((goalId: string, facts: string | null): void => {
    setProgressFacts(previous => previous[goalId] === facts || facts === null && previous[goalId]
      ? previous : { ...previous, [goalId]: facts });
  }, []);

  useBlockNativeSurfaces(open);

  useEffect(() => {
    setGoals(previous => mergeGoals(previous, [latestGoal, viewGoal].filter((item): item is ConversationGoalDto => item?.taskId === taskId)));
  }, [latestGoal, viewGoal, taskId]);

  useEffect(() => {
    if (!viewGoal) return;
    setSelected(viewGoal.id);
    setEditing(false);
    setOpen(true);
  }, [viewGoal]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const api = window.api?.conversationRuntime;
    if (!api) {
      setLoadError("Goal 服务不可用");
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    void api.snapshot(taskId).then(snapshot => {
      if (live && snapshot.taskId === taskId) setGoals(previous => mergeGoals(previous,
        (snapshot.goals ?? (snapshot.activeGoal ? [snapshot.activeGoal] : [])).filter(item => item.taskId === taskId)));
    }).catch((cause: unknown) => {
      if (live) setLoadError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [open, taskId, latestGoal, refreshRevision]);

  useEffect(() => {
    if (!open) return;
    const api = window.api?.conversationRuntime;
    if (!api?.goalEvidence) return;
    let active = true;
    const readList = async (): Promise<void> => {
      for (const item of visibleGoals) {
        if (!active) return;
        if (item.id === selectedId) continue; // The open detail already refreshes its own evidence.
        const revision = JSON.stringify([item.version, item.closedAt, item.continuation?.lastCheck?.at]);
        if (readListVersions.current.get(item.id) === revision) continue;
        try {
          const details = await api.goalEvidence(taskId, item.id);
          if (!active) return;
          readListVersions.current.set(item.id, revision);
          recordProgress(item.id, details ? goalProgressFacts(details) : null);
        } catch {
          if (active) recordProgress(item.id, null);
        }
      }
    };
    void readList();
    return () => { active = false; };
  }, [open, taskId, visibleGoals, selectedId, recordProgress]);

  const refresh = (): void => setRefreshRevision(revision => revision + 1);
  const close = (): void => {
    setOpen(false);
    setEditing(false);
    setProgressFacts({});
    readListVersions.current.clear();
    triggerRef.current?.focus();
  };
  const selectGoal = (id: string | null): void => {
    setEditing(false);
    setError(null);
    setSelected(id);
  };

  useEffect(() => {
    if (!open || !showForm) { seeded.current = null; return; }
    if (seeded.current && seeded.current.goal?.id === goal?.id) return;
    seeded.current = { goal: goal && { ...goal, criteria: goal.criteria.map(criterion => ({ ...criterion })) } };
    setTitle(goal?.title ?? "");
    setDescription(goal?.description ?? "");
    setCriteria(goal?.criteria.map((item) => item.text).join("\n") ?? "");
    setProgress(goal?.progressSummary ?? "");
    const override = budgetOverride(goal);
    setBudget(override !== null ? String(override) : "");
    setError(null);
  }, [open, goal, showForm]);

  const budgetValue = (): number | null => {
    if (!budget.trim()) return null;
    const value = Number(budget);
    if (!Number.isFinite(value) || value < 1) throw new Error("token 预算必须是正整数，或留空表示不限");
    return Math.round(value);
  };

  const save = async (): Promise<void> => {
    if (!showForm || !title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const api = window.api?.conversationRuntime;
      const tokenBudget = budgetValue();
      const baseline = seeded.current?.goal;
      if (baseline?.id !== goal?.id) throw new Error("Goal 已变更，请重新打开编辑。");
      const texts = criteria.split(/\r?\n/).map(text => text.trim()).filter(Boolean);
      const changes: Pick<ConversationGoalUpdateRequest, "title" | "description" | "progressSummary" | "tokenBudget" | "criteria"> = {};
      if (baseline) {
        if (title.trim() !== baseline.title) changes.title = title.trim();
        if (description.trim() !== (baseline.description ?? "")) changes.description = description.trim();
        if (progress.trim() !== (baseline.progressSummary ?? "")) changes.progressSummary = progress.trim();
        if (tokenBudget !== budgetOverride(baseline)) changes.tokenBudget = tokenBudget;
        if (texts.length !== baseline.criteria.length || texts.some((text, index) => text !== baseline.criteria[index]?.text)) {
          const unused = [...baseline.criteria];
          changes.criteria = texts.map(text => {
            const index = unused.findIndex(criterion => criterion.text === text);
            return index < 0 ? { text } : { id: unused.splice(index, 1)[0].id, text };
          });
        }
        if (!Object.keys(changes).length) { setEditing(false); return; }
      }
      const result = baseline
        ? await api?.updateGoal({ goalId: baseline.id, taskId, ...goalWitness(baseline), ...changes })
        : await api?.createGoal({ taskId, title: title.trim(), description: description.trim(), tokenBudget,
          criteria: texts.map(text => ({ text })) });
      if (!result?.ok) {
        if (result?.code === "conflict") refresh();
        throw new Error(result?.message ?? "保存 Goal 失败");
      }
      setGoals(items => mergeGoals(items, [result.goal]));
      if (!baseline) setSelected(current => current ?? result.goal.id);
      setEditing(false);
      seeded.current = null;
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: "paused" | "active"): Promise<void> => {
    if (!goal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.api?.conversationRuntime?.updateGoal({ goalId: goal.id, taskId, status, ...goalWitness(goal) });
      if (!result?.ok) {
        if (result?.code === "conflict") refresh();
        throw new Error(result?.message ?? "更新 Goal 状态失败");
      }
      setGoals(items => mergeGoals(items, [result.goal]));
      seeded.current = null;
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const continueGoal = async (): Promise<void> => {
    if (!goal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.api?.conversationRuntime?.resumeGoalContinuation(goal.id, taskId, {
        ...goalWitness(goal), expectedContinuationRevision: goal.continuation?.revision,
      });
      if (!result?.ok) {
        if (result?.code === "conflict") refresh();
        throw new Error(result?.message ?? "继续 Goal 失败");
      }
      setGoals(items => mergeGoals(items, [result.goal]));
      seeded.current = null;
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const cancelGoal = async (): Promise<void> => {
    if (!goal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.api?.conversationRuntime?.cancelGoal(goal.id, taskId, goalWitness(goal));
      if (!result?.ok) {
        if (result?.code === "conflict") refresh();
        throw new Error(result?.message ?? "取消 Goal 失败");
      }
      setGoals(items => mergeGoals(items, [result.goal]));
      seeded.current = null;
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const met = activeGoal?.criteria.filter((item) => item.status === "met" || item.status === "waived").length ?? 0;
  const continuation = goal?.continuation;
  const chipContinuation = activeGoal?.continuation;
  const continuationLabel = chipContinuation
    ? `${chipContinuation.attempts}/${chipContinuation.maxAttempts}${chipContinuation.state === "deferred" ? " · 暂停" : chipContinuation.state === "exhausted" ? " · 用尽" : ""}`
    : null;
  const stopSummary = goalContinuationSummary(chipContinuation);
  const waitingSummary = goal && goalWaitingSummary(goal);
  const canContinue = goal?.status === "active" && (continuation?.state === "deferred" || continuation?.state === "exhausted");
  return (
    <>
      <button ref={triggerRef} type="button" aria-label="此对话的 Goal" className={`conversation-goal-chip${activeGoal ? " has-goal" : ""}`} onClick={() => {
        setOpen(true);
      }} title={activeGoal ? activeGoal.description || activeGoal.title : "查看此对话的 Goal"}>
        <IconTarget size={13} strokeWidth={1.5} />
        <span className="conversation-goal-chip-label">{activeGoal ? activeGoal.title : "Goal"}</span>
        {activeGoal && activeGoal.criteria.length > 0 && <small>{met}/{activeGoal.criteria.length}</small>}
        {continuationLabel && <small title={stopSummary ?? "宿主自动续跑"}>{continuationLabel}</small>}
      </button>
      {open && createPortal(
        <div className="conversation-goal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
          <section className="conversation-goal-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-goal-title"
            onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
            <header><div><span className="conversation-runtime-kicker">Task 长期目标</span><h2 id="conversation-goal-title">{goal ? goal.title : "建立 Goal"}</h2></div><button type="button" aria-label="关闭" autoFocus onClick={close}>×</button></header>
            {visibleGoals.length > 0 && <nav aria-label="此对话的 Goal" className="conversation-goal-list">
              <ul>
                {visibleGoals.map(item => {
                  const waiting = goalWaitingSummary(item);
                  return <li key={item.id}>
                  <button type="button" disabled={busy} aria-current={selectedId === item.id ? "true" : undefined}
                    onClick={() => selectGoal(item.id)}>
                    <span><strong>{item.title}</strong> <small>{statusLabel(item)}</small></span>
                    <span>进展：{progressText(item, progressFacts[item.id])}</span>
                    {waiting && <span>等待／停止原因：{waiting}</span>}
                  </button>
                </li>;
                })}
              </ul>
              <button type="button" disabled={busy} onClick={() => selectGoal(null)}>建立 Goal</button>
            </nav>}
            {loading && visibleGoals.length === 0 && <p role="status">正在读取 Goal…</p>}
            {loadError && <p role="alert">{loadError} <button type="button" onClick={refresh}>重试</button></p>}
            {goal && (!editing || readOnly) && <>
              <p>状态：{statusLabel(goal)}</p>
              {waitingSummary && <p role="status">等待／停止原因：{waitingSummary}</p>}
              <p>进展：{progressText(goal, progressFacts[goal.id])}</p>
              {goal.description && <p>{goal.description}</p>}
              <ConversationGoalEvidence key={goal.id} taskId={taskId} goal={goal} onChanged={refresh} onProgress={recordProgress}>
                {goal.criteria.length > 0 && <ul className="conversation-goal-criteria" aria-label="验收条件">
                  {goal.criteria.map(item => <li key={item.id}><strong>{CRITERION_LABEL[item.status]}</strong> {item.text}</li>)}
                </ul>}
                {goal.source && <details>
                  <summary>原始消息</summary>
                  <pre className="conversation-goal-source">{goal.source.text}</pre>
                  <small>{goal.source.role === "assistant" ? "助手" : "用户"} · 会话 {goal.source.conversationId} · 消息 {goal.source.messageId}
                    {goal.source.entryId && ` · 条目 ${goal.source.entryId}`}
                    {goal.source.inputRequestId && ` · 请求 ${goal.source.inputRequestId}`}
                  </small>
                </details>}
                <footer className="conversation-goal-controls">
                  <div className="conversation-goal-actions">
                    {!readOnly && <button type="button" disabled={busy} onClick={() => { setError(null); setEditing(true); }}>编辑 Goal</button>}
                    {(goal.status === "active" || goal.status === "blocked") && <button type="button" disabled={busy} onClick={() => void setStatus("paused")}>暂停</button>}
                    {goal.status === "paused" && <button type="button" disabled={busy} onClick={() => void setStatus("active")}>恢复</button>}
                    {canContinue && <button type="button" className="primary" disabled={busy} onClick={() => void continueGoal()}>继续</button>}
                    {!readOnly && <button type="button" className="danger" disabled={busy} onClick={() => void cancelGoal()}>取消 Goal</button>}
                  </div>
                </footer>
                {error && <div className="conversation-interaction-error" role="alert">{error}</div>}
              </ConversationGoalEvidence>
            </>}
            {showForm && <form onSubmit={event => { event.preventDefault(); void save(); }}>
              <label>目标标题<input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} placeholder="这段对话最终要达成什么？" /></label>
              <label>说明（可选）<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <label>成功标准（每行一条，最多 12 条）<textarea rows={5} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder={"结果可以被验证\n关键交付物已完成"} /></label>
              {goal && <label>当前进展<textarea rows={3} value={progress} onChange={(event) => setProgress(event.target.value)} /></label>}
              <label>自动续跑 token 预算（留空 = 跟随全局设置）<input inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="例如 50000" /></label>
              {error && <div className="conversation-interaction-error" role="alert">{error}</div>}
              <footer><div className="conversation-goal-save">
                <button type="button" disabled={busy} onClick={goal ? () => { setError(null); setEditing(false); } : close}>返回</button>
                <button type="submit" className="primary" disabled={busy || !title.trim()}>{busy ? "保存中…" : "保存"}</button>
              </div></footer>
            </form>}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
