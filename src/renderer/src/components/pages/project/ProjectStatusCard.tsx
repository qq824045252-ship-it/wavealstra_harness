import { useCallback, useEffect, useState } from "react";
import type { ProjectActionProposalDto, ProjectDetailsDto, ProjectStatusSnapshotDto } from "@shared/project-domain";
import { formatRelativeTime } from "@/lib/projectWorkspace";

interface Props {
  project: ProjectDetailsDto;
  onOpenTask: (taskId: string) => void;
  onNavigateTab: (tab: "plan" | "memory" | "tasks") => void;
  onToast: (text: string) => void;
}

const HEALTH_LABEL: Record<string, { icon: string; label: string; cls: string }> = {
  red: { icon: "🔴", label: "有阻塞", cls: "health-red" },
  yellow: { icon: "🟡", label: "有风险", cls: "health-yellow" },
  green: { icon: "🟢", label: "正常", cls: "health-green" },
};

function shortDate(ms: number | null | undefined): string {
  if (!ms) return "从未";
  return new Date(ms).toISOString().slice(0, 10);
}

/** Project Operations Cockpit：纯派生状态展示（health/阻塞/风险/下一步/review），不修改业务数据 */
export default function ProjectStatusCard({ project, onOpenTask, onNavigateTab, onToast }: Props): React.JSX.Element | null {
  const [snap, setSnap] = useState<ProjectStatusSnapshotDto | null>(null);
  const [proposals, setProposals] = useState<ProjectActionProposalDto[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [next, nextProposals] = await Promise.all([
        window.api?.db?.getProjectStatus(project.id),
        window.api?.db?.getProjectActions(project.id),
      ]);
      if (next) setSnap(next);
      if (nextProposals) setProposals(nextProposals);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "状态加载失败");
    }
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload, project.updatedAt]);

  // 任务状态/绑定变化即时刷新（主进程广播 projectTaskChanged；不轮询、不 bump 项目版本）
  useEffect(() => {
    const unsubscribe = window.api?.db?.onProjectTaskChanged?.((change) => {
      if (change.projectId === project.id) void reload();
    });
    return unsubscribe;
  }, [reload, project.id]);

  const openProposal = (p: ProjectActionProposalDto): void => {
    if (p.actionType === "locate_task" && p.targetRef) onOpenTask(p.targetRef);
    else if (p.actionType === "locate_plan") onNavigateTab("plan");
    else if (p.actionType === "needs_confirmation") onNavigateTab("memory");
  };

  const submitReview = async (): Promise<void> => {
    if (reviewing) return;
    setReviewing(true);
    try {
      await window.api?.db?.recordProjectReview({ projectId: project.id, note: note.trim() || undefined });
      onToast("已标记复核");
      setNote("");
      await reload();
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : "标记失败");
    } finally {
      setReviewing(false);
    }
  };

  if (!snap) {
    return (
      <div className="project-status-card">
        {error ? (
          <div className="project-status-error">{error}</div>
        ) : (
          <div className="project-status-empty">正在加载项目健康度…</div>
        )}
      </div>
    );
  }

  const health = HEALTH_LABEL[snap.health] ?? HEALTH_LABEL.green!;
  const openRef = (kind: string, refId: string): void => {
    if (kind === "task") onOpenTask(refId);
    else if (kind === "plan") onNavigateTab("plan");
    else if (kind === "memory") onNavigateTab("memory");
  };

  return (
    <div className="project-status-card">
      <div className="project-status-head">
        <span className={`project-status-health ${health.cls}`}>
          {health.icon} 项目健康度：{health.label}
        </span>
        <span className="project-status-meta">
          任务 {snap.tasks.doing}/{snap.tasks.active} 进行中 · 计划逾期 {snap.plan.overdue} · 记忆风险 {snap.memory.risks}
        </span>
        <span className="input-spacer" />
        {project.archived ? (
          <span className="project-status-review-hint">已归档（只读）</span>
        ) : (
          <button type="button" className="btn" disabled={reviewing} onClick={() => setReviewing((v) => !v)}>
            标记已复核
          </button>
        )}
        <button type="button" className="btn" onClick={() => void reload()} title="重新计算派生状态">
          刷新
        </button>
      </div>
      {reviewing && !project.archived && (
        <div className="project-status-review-row">
          <input
            className="new-project-input"
            value={note}
            maxLength={500}
            placeholder="本轮复核结论/关注点（可选）"
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="button" className="btn primary" onClick={() => void submitReview()}>
            记录
          </button>
        </div>
      )}
      {proposals.length > 0 && (
        <div className="project-status-proposals">
          <div className="project-status-section-title">建议动作（仅用于定位，不会自动修改项目数据）</div>
          {proposals.map((p) => (
            <div key={p.id} className={`project-status-proposal proposal-${p.status}`}>
              <button type="button" className="project-status-issue" onClick={() => openProposal(p)}>
                <span className={`issue-dot ${p.actionType === "locate_task" ? "task" : p.actionType === "locate_plan" || p.actionType === "update_plan_status" ? "plan" : "memory"}`} />
                <span className="issue-title">{p.title}</span>
                <span className="issue-reason">
                  {p.status === "applied" ? "历史已执行" : p.status === "stale" ? "已失效(stale)" : p.status === "obsolete" ? "已失效(obsolete)" : p.actionType.startsWith("locate") ? "定位" : "仅建议"}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="project-status-grid">
        <div className="project-status-section">
          <div className="project-status-section-title">阻塞项（{snap.blockers.length}）</div>
          {snap.blockers.length === 0 ? (
            <div className="project-status-empty">无</div>
          ) : (
            snap.blockers.map((b) => (
              <button key={`b-${b.source}-${b.refId}`} type="button" className="project-status-issue" onClick={() => openRef(b.source, b.refId)}>
                <span className={`issue-dot ${b.source}`} />
                <span className="issue-title">{b.title}</span>
                <span className="issue-reason">{b.reason}</span>
              </button>
            ))
          )}
        </div>
        <div className="project-status-section">
          <div className="project-status-section-title">风险项（{snap.atRisks.length}）</div>
          {snap.atRisks.length === 0 ? (
            <div className="project-status-empty">无</div>
          ) : (
            snap.atRisks.map((r) => (
              <button key={`r-${r.source}-${r.refId}`} type="button" className="project-status-issue" onClick={() => openRef(r.source, r.refId)}>
                <span className={`issue-dot ${r.source}`} />
                <span className="issue-title">{r.title}</span>
                <span className="issue-reason">{r.reason}</span>
              </button>
            ))
          )}
        </div>
        <div className="project-status-section">
          <div className="project-status-section-title">下一步（{snap.nextActions.length}）</div>
          {snap.nextActions.length === 0 ? (
            <div className="project-status-empty">无进行中的计划项或任务</div>
          ) : (
            snap.nextActions.map((a) => (
              <button key={`a-${a.source}-${a.refId}`} type="button" className="project-status-issue" onClick={() => openRef(a.source, a.refId)}>
                <span className={`issue-dot ${a.source}`} />
                <span className="issue-title">{a.title}</span>
                <span className="issue-reason">{a.dueAt ? `截止 ${shortDate(a.dueAt)}` : a.source === "task" ? "进行中任务" : "计划项"}</span>
              </button>
            ))
          )}
        </div>
      </div>
      <div className="project-status-foot">
        最近活动 {formatRelativeTime(snap.lastActivityAt)} · 最近复核 {shortDate(snap.lastReviewedAt)} · 状态为派生视图（源：任务/计划/记忆），不缓存不猜测
      </div>
    </div>
  );
}
