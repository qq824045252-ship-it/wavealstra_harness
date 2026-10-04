import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MemoryKernelStats,
  MemorySkillLearningStatusDto,
  MemorySkillCandidateDto,
  MemorySkillEffectivenessDto,
  MemorySkillEffectivenessSummaryDto,
  MemorySkillFeedbackKind,
  MemorySkillRevisionCandidateDto,
  MemorySkillHistoryDeleteRequest,
} from "@shared/memory-kernel";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { useTextPrompt } from "@/components/common/useTextPrompt";
import { useAppStore } from "@/store/appStore";
import MemorySkillHistoryControls, { useSkillHistorySelection } from "./MemorySkillHistoryControls";

const SCOPE_LABEL: Record<string, string> = {
  global: "全局",
  workspace: "工作空间",
  project: "项目",
  task: "任务",
};

const CANDIDATE_LABEL: Record<string, string> = { draft: "待完善", ready: "待批准", materialized: "已生成", stale: "已过期", rejected: "已拒绝" };
const FEEDBACK_LABEL: Record<string, string> = { helpful: "有帮助", needs_revision: "需修订", incorrect: "错误" };
const OUTCOME_LABEL: Record<string, string> = { pending: "进行中", completed: "已完成", failed: "失败", aborted: "已中止", unknown: "未知" };
const INVOCATION_LABEL: Record<string, string> = { command: "命令调用", read: "读取技能", invoked: "已调用" };
const isPending = (item: { status: string }): boolean => item.status === "draft" || item.status === "ready";
const isDeletableHistory = (item: { status: string }): boolean => item.status === "stale" || item.status === "rejected";

function fmt(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions = {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return new Intl.DateTimeFormat("zh-CN", opts).format(d);
}

/** Procedure → Skill 学习链管理面：候选批准、修订候选、真实调用效果反馈。 */
export default function MemorySkillPanel({ onOpenMemory }: { onOpenMemory: (id: string) => void }): React.JSX.Element {
  const [stats, setStats] = useState<MemoryKernelStats | null>(null);
  const [skillCandidates, setSkillCandidates] = useState<MemorySkillCandidateDto[]>([]);
  const [learningStatus, setLearningStatus] = useState<MemorySkillLearningStatusDto>();
  const [skillEffectiveness, setSkillEffectiveness] = useState<MemorySkillEffectivenessDto[]>([]);
  const [skillEffectivenessSummary, setSkillEffectivenessSummary] = useState<MemorySkillEffectivenessSummaryDto[]>([]);
  const [skillRevisions, setSkillRevisions] = useState<MemorySkillRevisionCandidateDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<"pending" | "materialized" | "history">("pending");
  const [showRevisionHistory, setShowRevisionHistory] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ request: MemorySkillHistoryDeleteRequest; label: string } | null>(null);
  const history = useMemo(() => skillCandidates.filter(isDeletableHistory), [skillCandidates]);
  const revisionHistory = useMemo(() => skillRevisions.filter(isDeletableHistory), [skillRevisions]);
  const historySelection = useSkillHistorySelection(history, group === "history");
  const revisionSelection = useSkillHistorySelection(revisionHistory, showRevisionHistory);
  const loadRequest = useRef(0);
  const { requestText, textPromptDialog } = useTextPrompt();

  const load = useCallback(async (): Promise<void> => {
    const api = window.api?.memory;
    if (!api) return;
    const request = ++loadRequest.current;
    setLoading(true);
    try {
      const [nextStats, learnedItems, effectivenessItems, effectivenessSummary, revisionItems, nextLearningStatus] = await Promise.all([
        api.stats(),
        api.skillCandidates(undefined, 1000),
        api.skillEffectiveness(100, true),
        api.skillEffectivenessSummary(100),
        api.skillRevisionCandidates(undefined, 100),
        api.skillLearningStatus?.(),
      ]);
      if (request !== loadRequest.current) return;
      setStats(nextStats);
      setSkillCandidates(learnedItems);
      setSkillEffectiveness(effectivenessItems);
      setSkillEffectivenessSummary(effectivenessSummary);
      setSkillRevisions(revisionItems);
      setLearningStatus(nextLearningStatus);
    } catch (error) {
      if (request === loadRequest.current) setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { loadRequest.current += 1; };
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.api?.db?.onMemoryChanged?.(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 350);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [load]);

  const refreshLearned = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setStatus("正在评估可学习的流程…");
    try {
      const result = await window.api?.memory?.refreshSkillCandidates();
      if (result) setStatus(`评估完成：检查 ${result.evaluated} 条流程，待批准 ${result.ready} 条，新增 ${result.created} 条，过期 ${result.staled} 条。`);
      setGroup("pending");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const retryLearning = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const api = window.api?.memory;
      if (!api) throw new Error("记忆服务尚未就绪，请稍后重试");
      const reset = await api.retryFailedTurns();
      setStatus(reset ? `已安排重试 ${reset} 条失败对话，提炼完成后候选会自动更新。` : "没有可重试的失败对话。");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const deleteHistory = async (): Promise<void> => {
    const api = window.api?.memory;
    if (busy || !api || !pendingDelete) return;
    const { request } = pendingDelete;
    setPendingDelete(null);
    setBusy(true);
    try {
      const deleted = await api.deleteSkillHistory(request);
      (request.kind === "candidate" ? historySelection : revisionSelection).clear();
      setStatus(`已删除 ${deleted} 条${request.kind === "candidate" ? "技能" : "修订"}历史记录。`);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const decideLearned = async (id: string, action: "approve" | "reject"): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      if (action === "approve") {
        const updated = await window.api?.memory?.approveSkillCandidate(id);
        if (updated) { setStatus(`已生成技能「${updated.title}」，自动调用默认关闭；可前往技能中心启用。`); setGroup("materialized"); }
      } else {
        await window.api?.memory?.rejectSkillCandidate(id);
        setStatus("已拒绝该技能候选。");
      }
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const setSkillFeedback = async (id: string, kind: MemorySkillFeedbackKind | null): Promise<void> => {
    if (busy) return;
    let note: string | undefined;
    if (kind === "needs_revision" || kind === "incorrect") {
      const entered = await requestText({
        title: kind === "incorrect" ? "说明错误" : "说明修订需求",
        label: kind === "incorrect" ? "请说明哪里错误（用于生成可审计修订候选）" : "请说明需要如何修订",
        initialValue: "",
        multiline: true,
        allowEmpty: true,
        maxLength: 4000,
        confirmLabel: "记录反馈",
      });
      if (entered === null) return;
      note = entered.trim();
    }
    setBusy(true);
    try {
      await window.api?.memory?.setSkillFeedback(id, kind, note);
      setStatus(kind === "helpful" ? "已记录：这次调用有帮助。" : kind ? (note ? "已记录反馈并更新修订建议；批准后才会修改技能。" : "已记录反馈；补充具体修订说明后才能批准新版。") : "已清除这次调用的反馈。");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const refreshSkillRevisions = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.api?.memory?.refreshSkillRevisionCandidates();
      if (result) setStatus(`修订评估完成：检查 ${result.evaluated} 个技能，新增 ${result.created} 条，待批准 ${result.ready} 条，过期 ${result.staled} 条。`);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const decideSkillRevision = async (id: string, action: "approve" | "reject"): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      if (action === "approve") {
        const result = await window.api?.memory?.approveSkillRevisionCandidate(id);
        if (result) setStatus(`已生成技能 ${result.candidate.materializedVersion ?? "新版"}；自动调用默认关闭，请前往技能中心确认启用。`);
      } else {
        await window.api?.memory?.rejectSkillRevisionCandidate(id);
        setStatus("已拒绝该修订建议。");
      }
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const pending = skillCandidates.filter(isPending);
  const generated = skillCandidates.filter((item) => item.status === "materialized");
  const visibleCandidates = group === "pending" ? pending : group === "materialized" ? generated : history;
  const visibleRevisions = skillRevisions.filter((item) => showRevisionHistory || isPending(item));
  const openSkills = (): void => { useAppStore.getState().setPage("skills"); useAppStore.getState().setSettingsOpen(false); };

  return (
    <div className="memory-tab-scroll">
      <div className="memory-toolbar">
        <span className="memory-count">待处理 {stats?.skillCandidates ?? 0}</span>
        <span className="memory-count">待修订 {stats?.skillRevisionCandidates ?? 0}</span>
        <span className="memory-count">实际调用 {stats?.skillInvocations ?? 0}</span>
      </div>
      <div className="memory-toolbar">
        <button type="button" className="btn" disabled={busy} onClick={() => void refreshLearned()}>
          评估可学习流程
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void refreshSkillRevisions()}>
          重新评估修订
        </button>
        <button type="button" className="btn" disabled={busy || loading} onClick={() => void load()}>
          {loading ? "加载中…" : "刷新"}
        </button>
        <button type="button" className="btn" onClick={openSkills}>前往技能中心</button>
      </div>

      {status ? <div className="memory-status" role="status">{status}</div> : null}
      {learningStatus && <div className="settings-row-desc" style={{ marginBottom: 10 }}>
        <div>流程记忆 {learningStatus.procedures} 条 · 可复用 {learningStatus.reusableProcedures} 条 · 待提炼 {learningStatus.pendingTurns ?? stats?.pendingTurns ?? 0} 条</div>
        {learningStatus.reusableProcedures === 0 && <div>尚无可复用流程。完成带有实际检查结果的工具任务，或明确说明以后要遵循的方法，系统会自动提炼待审核技能。</div>}
        {learningStatus.failedTurns > 0 && <div role="status">有 {learningStatus.failedTurns} 条对话提炼失败：{learningStatus.latestError}
          <button type="button" className="btn" disabled={busy || learningStatus.retryableFailedTurns === 0} onClick={() => void retryLearning()}>重试失败提炼</button>
          {learningStatus.retryableFailedTurns < learningStatus.failedTurns && <div>其中 {learningStatus.retryableFailedTurns} 条可重试；归档项目、回收或已失去归属的任务保留历史记录，不参与提炼。</div>}
        </div>}
        {learningStatus.blockedSkills.map((skill) => <div key={skill.id}>技能「{skill.title}」：{skill.reason}</div>)}
      </div>}

      <div style={{ border: "1px solid var(--border-subtle, rgba(128,128,128,.2))", borderRadius: 8, padding: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>从记忆学习技能</div>
        <div className="settings-row-desc" style={{ marginBottom: 8 }}>
          成功任务中的可复用方法会自动进入待处理列表。先查看来源和拟议内容，再批准生成技能。新技能默认关闭自动调用，可前往技能中心启用。
        </div>
        <div className="memory-skill-groups" aria-label="技能候选分组">
          {([ ["pending", "待处理", pending.length], ["materialized", "已生成", generated.length], ["history", "历史记录", history.length] ] as const).map(([id, label, count]) => <button key={id} type="button" className={`btn ${group === id ? "active" : ""}`} aria-pressed={group === id} disabled={busy} onClick={() => setGroup(id)}>{label} {count}</button>)}
        </div>
        {group === "history" && <p className="settings-row-desc memory-history-note">历史快照仅供审核。来源变更或删除后，旧候选不会继续生效。</p>}
        {skillCandidates.length >= 1000 && <p className="settings-row-desc">这里显示最近 1000 条记录。</p>}
        {group === "history" && <MemorySkillHistoryControls selection={historySelection} disabled={busy || loading} kind="candidate"
          onDeleteSelected={() => setPendingDelete({ request: { kind: "candidate", ids: historySelection.selectedIds }, label: `选中的 ${historySelection.selectedIds.length} 条技能历史记录` })}
          onDeleteAll={() => setPendingDelete({ request: { kind: "candidate", all: true }, label: "全部技能历史记录" })} />}
        {loading && skillCandidates.length === 0 ? <div className="memory-empty">正在加载候选…</div> : visibleCandidates.length === 0 ? (
          <div className="memory-empty">{group === "pending" ? "暂无待处理流程。点击「评估可学习流程」检查记忆；仅属于单个任务的流程不会成为通用技能。" : "当前分组暂无记录。"}</div>
        ) : visibleCandidates.map((candidate) => (
          <div key={candidate.id} className="memory-skill-record">
            <div className="memory-skill-record-heading">
              {group === "history" && <label className="memory-projection-select"><input type="checkbox" aria-label={`选择技能历史：${candidate.title}`} checked={historySelection.has(candidate.id)} disabled={busy || loading} onChange={() => historySelection.toggle(candidate.id)} /></label>}
              <strong>{candidate.title}</strong>
              <span className="memory-source manual">{CANDIDATE_LABEL[candidate.status]}</span>
              <span className="memory-source manual">{SCOPE_LABEL[candidate.scopeType] ?? candidate.scopeType}</span>
              <span style={{ flex: 1 }} />
              {(candidate.status === "draft" || candidate.status === "ready") ? (
                <>
                  <button type="button" className="btn" disabled={busy} onClick={() => void decideLearned(candidate.id, "reject")}>拒绝</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void decideLearned(candidate.id, "approve")}>
                    {candidate.status === "ready" ? "批准生成技能" : "确认生成技能"}
                  </button>
                </>
              ) : null}
              {isDeletableHistory(candidate) && <button type="button" className="btn danger" aria-label={`删除技能历史：${candidate.title}`} disabled={busy || loading} onClick={() => setPendingDelete({ request: { kind: "candidate", ids: [candidate.id] }, label: `「${candidate.title}」的历史记录` })}>删除</button>}
            </div>
            <div className="settings-row-desc" style={{ marginTop: 3 }}>支持任务 {candidate.distinctTaskCount} 个 · 已完成 {candidate.completedTaskCount} 个 · 证据 {candidate.evidenceCount} 条 · {fmt(candidate.updatedAt)}</div>
            <div className="settings-row-desc memory-skill-description">{candidate.description}</div>
            <details style={{ marginTop: 5 }}>
              <summary className="settings-row-desc" style={{ cursor: "pointer" }}>{candidate.status === "materialized" ? "查看生成时的内容" : "查看技能内容"}</summary>
              <pre className="settings-row-desc" style={{ marginTop: 5, whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>{candidate.instructions}</pre>
            </details>
            <div className="memory-toolbar memory-skill-record-actions">
              {candidate.sourceMemoryIds.map((id, index) => <button type="button" className="btn" key={id} disabled={busy} onClick={() => onOpenMemory(id)}>查看来源记忆{candidate.sourceMemoryIds.length > 1 ? ` ${index + 1}` : ""}</button>)}
              {candidate.installedSkillId ? <button type="button" className="btn" disabled={busy} onClick={openSkills}>在技能中心管理</button> : null}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, border: "1px solid var(--border-subtle, rgba(128,128,128,.2))", borderRadius: 8, padding: 10 }}>
        <div className="memory-toolbar"><strong>技能修订</strong><button type="button" className="btn" disabled={busy || loading} aria-pressed={showRevisionHistory} onClick={() => setShowRevisionHistory((v) => !v)}>{showRevisionHistory ? "收起历史" : "查看修订历史"}</button></div>
        <div className="settings-row-desc" style={{ marginBottom: 8 }}>
          对实际调用标记「需修订」或「错误」并说明原因后，会形成修订建议。批准前会核对版本，保护你后来手动修改的内容。
        </div>
        {showRevisionHistory && <MemorySkillHistoryControls selection={revisionSelection} disabled={busy || loading} kind="revision"
          onDeleteSelected={() => setPendingDelete({ request: { kind: "revision", ids: revisionSelection.selectedIds }, label: `选中的 ${revisionSelection.selectedIds.length} 条修订历史记录` })}
          onDeleteAll={() => setPendingDelete({ request: { kind: "revision", all: true }, label: "全部已过期或已拒绝的修订历史" })} />}
        {visibleRevisions.length === 0 ? <div className="memory-empty">暂无待处理修订建议。</div> : visibleRevisions.map((item) => (
          <div key={item.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border-subtle, rgba(128,128,128,.12))" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {showRevisionHistory && isDeletableHistory(item) && <label className="memory-projection-select"><input type="checkbox" aria-label={`选择修订历史：${item.title}`} checked={revisionSelection.has(item.id)} disabled={busy || loading} onChange={() => revisionSelection.toggle(item.id)} /></label>}
              <strong title={item.skillId}>{item.title || item.skillId}</strong>
              <span className="memory-source manual">{CANDIDATE_LABEL[item.status]}</span>
              <span className="settings-row-desc">基于版本 {item.baseVersion}</span>
              <span className="settings-row-desc">需修订 {item.needsRevisionCount} · 错误 {item.incorrectCount} · 调用失败 {item.failedInvocationCount}</span>
              <span style={{ flex: 1 }} />
              {(item.status === "draft" || item.status === "ready") ? <button type="button" className="btn" disabled={busy} onClick={() => void decideSkillRevision(item.id, "reject")}>拒绝</button> : null}
              {item.status === "ready" ? <button type="button" className="btn" disabled={busy} onClick={() => void decideSkillRevision(item.id, "approve")}>批准新版</button> : null}
              {isDeletableHistory(item) && <button type="button" className="btn danger" aria-label={`删除修订历史：${item.title}`} disabled={busy || loading} onClick={() => setPendingDelete({ request: { kind: "revision", ids: [item.id] }, label: `「${item.title}」的修订历史` })}>删除</button>}
            </div>
            <div className="settings-row-desc" style={{ marginTop: 4 }}>{item.issueSummary}</div>
            {item.status === "draft" ? <div className="settings-row-desc" style={{ marginTop: 3 }}>需要在负反馈中补充具体修订说明后才能批准。</div> : null}
            {item.status === "materialized" ? <div className="settings-row-desc" style={{ marginTop: 3 }}>已生成版本：{item.materializedVersion ?? "新版"}</div> : null}
            <details style={{ marginTop: 5 }}>
              <summary className="settings-row-desc" style={{ cursor: "pointer" }}>查看拟议技能内容</summary>
              <pre style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", margin: "6px 0 0", fontSize: 12 }}>{item.proposedInstructions}</pre>
            </details>
            <details style={{ marginTop: 3 }}>
              <summary className="settings-row-desc" style={{ cursor: "pointer" }}>查看旧版快照</summary>
              <pre style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto", margin: "6px 0 0", fontSize: 12 }}>{item.baseInstructions}</pre>
            </details>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, border: "1px solid var(--border-subtle, rgba(128,128,128,.2))", borderRadius: 8, padding: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>技能使用反馈</div>
        <div className="settings-row-desc" style={{ marginBottom: 8 }}>
          统计区分「可供模型使用」和「实际调用」。反馈会形成可审核的修订建议，不会自动修改或停用技能。
        </div>
        {skillEffectivenessSummary.length === 0 ? (
          <div className="memory-empty">尚无已学习技能的使用反馈。</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginBottom: 10 }}>
            {skillEffectivenessSummary.map((item) => (
              <div key={`${item.skillId}:${item.candidateId ?? "legacy"}`} style={{ border: "1px solid var(--border-subtle, rgba(128,128,128,.14))", borderRadius: 7, padding: 8 }}>
                <strong>{item.skillId}</strong>
                {item.candidateId ? <div className="settings-row-desc">版本 {item.candidateId.slice(-10)}</div> : null}
                <div className="settings-row-desc" style={{ marginTop: 3 }}>
                  调用 {item.invocations}/{item.exposures} · 完成 {item.completedInvocations} · 失败 {item.failedInvocations} · 中止 {item.abortedInvocations}
                </div>
                <div className="settings-row-desc">
                  采用率 {(item.adoptionRate * 100).toFixed(0)}% · 完成率 {(item.completionRate * 100).toFixed(0)}% · 纠正率 {(item.correctionRate * 100).toFixed(0)}%
                </div>
                <div className="settings-row-desc">反馈 👍{item.helpfulFeedback} · 修订 {item.needsRevisionFeedback} · 错误 {item.incorrectFeedback}</div>
              </div>
            ))}
          </div>
        )}
        {skillEffectiveness.length > 0 ? (
          <>
            <div style={{ fontWeight: 600, marginBottom: 5 }}>最近实际调用</div>
            <div style={{ maxHeight: 320, overflow: "auto" }}>
              {skillEffectiveness.map((item) => (
                <div key={item.id} style={{ padding: "7px 0", borderBottom: "1px solid var(--border-subtle, rgba(128,128,128,.12))" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{item.skillId}</strong>
                    <span className="memory-source manual">{INVOCATION_LABEL[item.invocationKind ?? "invoked"] ?? "已调用"}</span>
                    <span className="settings-row-desc">{OUTCOME_LABEL[item.outcome] ?? "未知"} · {item.taskTitle ?? "原任务已删除"} · {fmt(item.invokedAt)}</span>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="btn" disabled={busy} onClick={() => void setSkillFeedback(item.id, item.feedbackKind === "helpful" ? null : "helpful")}>👍 有帮助</button>
                    <button type="button" className="btn" disabled={busy} onClick={() => void setSkillFeedback(item.id, item.feedbackKind === "needs_revision" ? null : "needs_revision")}>需修订</button>
                    <button type="button" className="btn" disabled={busy} onClick={() => void setSkillFeedback(item.id, item.feedbackKind === "incorrect" ? null : "incorrect")}>错误</button>
                  </div>
                  {item.feedbackKind ? <div className="settings-row-desc" style={{ marginTop: 3 }}>当前反馈：{FEEDBACK_LABEL[item.feedbackKind]}{item.feedbackNote ? ` · ${item.feedbackNote}` : ""}</div> : null}
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {textPromptDialog}
      <ConfirmDialog open={pendingDelete !== null} title={pendingDelete?.request.all ? "清空历史记录？" : "删除历史记录？"}
        body={pendingDelete && <>
          将永久删除{pendingDelete.label}，此操作不可恢复。{pendingDelete.request.all ? "包含未展开或超出列表显示数量的已过期、已拒绝记录。" : ""}<br />
          待处理记录、已生成记录、技能文件和来源记忆会保留。删除已拒绝记录后，再次评估可能产生相同建议。
        </>}
        confirmLabel={pendingDelete?.request.all ? "确认清空历史" : "确认删除历史"} danger onCancel={() => setPendingDelete(null)} onConfirm={() => void deleteHistory()} />
    </div>
  );
}
