import { useEffect, useRef, useState } from "react";
import type { ProjectDetailsDto } from "@shared/project-domain";
import { PROJECT_CONTEXT_GOAL_MAX_CHARS, PROJECT_CONTEXT_STAGE_MAX_CHARS } from "@shared/project-domain";
import { sameProjectFormValue, type ProjectUnsavedGuard } from "@/lib/projectWorkspace";

const fields = (project: ProjectDetailsDto) => ({ goal: project.goal ?? "", currentStage: project.currentStage ?? "", instructions: project.instructions ?? "" });

export default function ProjectBrief({ project, onRefresh, onRegisterUnsaved }: {
  project: ProjectDetailsDto; onRefresh: () => Promise<void>; onRegisterUnsaved?: (guard: ProjectUnsavedGuard | null) => void;
}): React.JSX.Element {
  const [form, setForm] = useState(() => fields(project));
  const baseline = useRef(fields(project));
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const dirty = !sameProjectFormValue(form, fields(project));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const next = fields(project);
    const previous = baseline.current;
    setForm((current) => sameProjectFormValue(current, previous) ? next : current);
    baseline.current = next;
  }, [project.goal, project.currentStage, project.instructions]);
  const discard = () => { setForm(fields(project)); setError(null); };
  const save = async () => {
    if (lock.current) throw new Error("正在保存项目说明");
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await window.api?.db?.updateProject?.({ id: project.id, goal: form.goal.trim() || null,
        currentStage: form.currentStage.trim() || null, instructions: form.instructions.trim() || null });
      if (!result?.ok) throw new Error(result?.error ?? "保存项目说明失败");
      if (alive.current) { setForm(fields(result.project)); await onRefresh(); }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "保存失败");
      throw cause;
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => { onRegisterUnsaved?.({ dirty, save, discard }); return () => onRegisterUnsaved?.(null); });
  return <details className="project-material-card project-material-collapsible project-brief">
    <summary className="project-material-summary">项目说明{dirty ? " · 未保存" : ""}</summary>
    <p className="project-desk-hint">目标、阶段和协作要求会提供给本项目所有任务。</p>
    <label className="new-project-field"><span className="new-project-label">项目目标</span>
      <textarea aria-label="项目目标" className="new-project-instructions" value={form.goal} maxLength={PROJECT_CONTEXT_GOAL_MAX_CHARS}
        disabled={busy || project.archived} placeholder="这个项目要达成什么" onChange={(event) => setForm({ ...form, goal: event.target.value })} /></label>
    <label className="new-project-field"><span className="new-project-label">当前阶段</span>
      <input aria-label="当前阶段" className="new-project-input" value={form.currentStage} maxLength={PROJECT_CONTEXT_STAGE_MAX_CHARS}
        disabled={busy || project.archived} placeholder="例如：方案确认中、样机调试" onChange={(event) => setForm({ ...form, currentStage: event.target.value })} /></label>
    <label className="new-project-field"><span className="new-project-label">协作要求</span>
      <textarea aria-label="协作要求" className="new-project-instructions" value={form.instructions}
        disabled={busy || project.archived} placeholder="团队习惯、输出格式和长期约束" onChange={(event) => setForm({ ...form, instructions: event.target.value })} /></label>
    <div className="project-desk-toolbar"><button className="btn primary" disabled={busy || !dirty || project.archived} onClick={() => { void save().catch(() => {}); }}>保存项目说明</button>
      <button className="btn" disabled={busy || !dirty} onClick={discard}>撤销修改</button></div>
    {error && <p role="alert">{error}</p>}
  </details>;
}
