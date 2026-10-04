import { useEffect, useState } from "react";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { sameProjectFormValue, type ProjectUnsavedGuard } from "@/lib/projectWorkspace";
import {
  MAX_PROJECT_RESOURCE_BUDGET_CHARS,
  MIN_PROJECT_RESOURCE_BUDGET_CHARS,
  type ProjectDetailsDto,
} from "@shared/project-domain";

const NAME_MAX = 40;

interface Props {
  project: ProjectDetailsDto;
  showArchived: boolean;
  onRefresh: () => Promise<void>;
  onArchived: () => void;
  onDeleted: () => void;
  onToast: (text: string) => void;
  onRegisterUnsaved: (guard: ProjectUnsavedGuard | null) => void;
}

export default function ProjectSettings({
  project,
  showArchived,
  onRefresh,
  onArchived,
  onDeleted,
  onToast,
  onRegisterUnsaved,
}: Props): React.JSX.Element {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [resourceBudgetChars, setResourceBudgetChars] = useState(project.resourceBudgetChars);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? "");
    setResourceBudgetChars(project.resourceBudgetChars);
  }, [project.id, project.updatedAt, project.name, project.description, project.resourceBudgetChars]);

  const savedForm = {
    name: project.name,
    description: project.description ?? "",
    resourceBudgetChars: project.resourceBudgetChars,
  };
  const editingForm = {
    name: name.trim(),
    description: description.trim(),
    resourceBudgetChars,
  };
  const dirty = !sameProjectFormValue(editingForm, savedForm);

  const discard = (): void => {
    setName(project.name);
    setDescription(project.description ?? "");
    setResourceBudgetChars(project.resourceBudgetChars);
    setError(null);
  };

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > NAME_MAX) {
      const message = "请填写项目名称";
      setError(message);
      throw new Error(message);
    }
    setSaving(true);
    setError(null);
    try {
      const result = await window.api?.db?.updateProject?.({
        id: project.id,
        name: trimmed,
        description: description.trim() || null,
        resourceBudgetChars,
      });
      if (!result?.ok) throw new Error(result?.error ?? "保存失败");
      await onRefresh();
      onToast("已保存");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message || "保存失败");
      throw cause instanceof Error ? cause : new Error(message);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    onRegisterUnsaved({ dirty, save, discard });
    return () => onRegisterUnsaved(null);
  });

  const duplicate = async (): Promise<void> => {
    setError(null);
    const result = await window.api?.db?.duplicateProject?.({ sourceId: project.id });
    if (!result?.ok) {
      setError(result?.error ?? "复制项目失败");
      return;
    }
    await onRefresh();
    onToast(`已复制为「${result.project.name}」`);
  };

  const archiveOrRestore = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.api?.db?.archiveProject?.(project.id, !project.archived);
      if (!result?.ok) {
        setError(result?.error ?? "操作失败");
        return;
      }
      await onRefresh();
      onToast(project.archived ? `已恢复「${project.name}」` : `已归档「${project.name}」`);
      if (!project.archived && !showArchived) onArchived();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.api?.db?.deleteProject?.(project.id);
      onDeleted();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="project-tab-body">
      <section className="project-section">
        <h3>基础信息</h3>
        <p className="project-desk-hint">项目目标、阶段、协作要求和常用资料统一在「资料」页维护。</p>
        <label className="new-project-field">
          <span className="new-project-label">项目名称</span>
          <div className="new-project-name-row">
            <input className="new-project-input" value={name} maxLength={NAME_MAX} onChange={(event) => setName(event.target.value)} />
            <span className="new-project-counter">{name.length}/{NAME_MAX}</span>
          </div>
        </label>
        <label className="new-project-field">
          <span className="new-project-label">项目描述</span>
          <input
            className="new-project-input project-description-input"
            value={description}
            placeholder="这个项目长期要完成什么"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="new-project-field">
          <span className="new-project-label">补充参考注入上限（字符）</span>
          <input
            className="new-project-input project-description-input"
            type="number"
            min={MIN_PROJECT_RESOURCE_BUDGET_CHARS}
            max={MAX_PROJECT_RESOURCE_BUDGET_CHARS}
            step={1000}
            value={resourceBudgetChars}
            onChange={(event) => setResourceBudgetChars(Number(event.target.value))}
          />
        </label>
        {error && <div className="project-form-error">{error}</div>}
        <div className="project-section-actions">
          <button type="button" className="btn primary" disabled={saving || !dirty || !name.trim()} onClick={() => void save().catch(() => undefined)}>
            {saving ? "保存中…" : "保存"}
          </button>
          <button type="button" className="btn" onClick={() => void duplicate()}>复制项目</button>
        </div>
      </section>

      <section className="project-section">
        <h3>归档项目</h3>
        <p className="project-settings-copy">
          归档后项目进入只读，所属自动化会停用；历史任务保留，恢复后自动化需手动重新启用。
        </p>
        <button type="button" className="btn" onClick={() => setConfirm("archive")}>
          {project.archived ? "恢复项目" : "归档项目"}
        </button>
      </section>

      <section className="project-section project-danger-zone">
        <h3>危险操作</h3>
        <p className="project-settings-copy">删除项目会清除项目计划、记忆作用域、资料库和自动化；任务保留并解除项目绑定。</p>
        <button type="button" className="btn danger" onClick={() => setConfirm("delete")}>删除项目</button>
      </section>

      <ConfirmDialog
        open={confirm === "archive"}
        title={project.archived ? `恢复项目 “${project.name}”？` : `归档项目 “${project.name}”？`}
        body={project.archived
          ? "恢复后项目会重新出现在默认项目列表中。"
          : "归档后项目进入只读并停用所属自动化。历史任务不会删除；恢复后自动化需手动重新启用。"}
        confirmLabel={project.archived ? "恢复项目" : "归档项目"}
        onCancel={() => !busy && setConfirm(null)}
        onConfirm={() => void archiveOrRestore()}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={`删除项目 “${project.name}”？`}
        body="此操作不可撤销。项目计划、记忆作用域、资料库和自动化会被删除；任务不会删除，只解除项目绑定。"
        confirmLabel="删除项目"
        danger
        onCancel={() => !busy && setConfirm(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
