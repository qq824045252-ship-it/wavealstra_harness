/**
 * Project Instructions Detail（实施规划 §8）。
 * Content Detail：多行编辑 Project 长期指令，只在 Save 时写入 project.instructions。
 * 不做 Prompt Builder / Version History / AI Rewrite（§8 第一阶段保持简单）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { sameProjectFormValue, type ProjectUnsavedGuard } from "@/lib/projectWorkspace";
import type { ProjectDetailsDto } from "@shared/project-domain";
import ProjectConfigDetailShell from "./ProjectConfigDetailShell";

interface Props {
  project: ProjectDetailsDto;
  onDirtyChange: (guard: ProjectUnsavedGuard | null) => void;
  onRefresh: () => Promise<void>;
  onToast: (text: string) => void;
}

const DETAIL_DESCRIPTION =
  "定义 AI 在这个项目中长期遵循的目标、背景、原则和工作方式。";

export default function ProjectInstructionsDetail({
  project,
  onDirtyChange,
  onRefresh,
  onToast,
}: Props): React.JSX.Element {
  const [draft, setDraft] = useState<string>(project.instructions ?? "");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saved = project.instructions ?? "";

  /** Project 外部刷新 → Draft 同步到新基线（§20 数据流） */
  useEffect(() => {
    setDraft(project.instructions ?? "");
    setError(null);
    setSaving(false);
  }, [project.id, project.updatedAt]);

  const dirty = draft !== saved;

  const discard = useCallback((): void => {
    setDraft(saved);
    setError(null);
  }, [saved]);

  const save = useCallback(async (): Promise<void> => {
    const current = draftRef.current;
    setSaving(true);
    setError(null);
    try {
      const result = await window.api?.db?.updateProject?.({
        id: project.id,
        instructions: current || null,
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
  }, [project.id, onRefresh, onToast]);

  useEffect(() => {
    onDirtyChange(dirty ? { dirty: true, save, discard } : null);
  }, [dirty, onDirtyChange, save, discard]);

  return (
    <ProjectConfigDetailShell
      title="项目指令"
      description={DETAIL_DESCRIPTION}
      dirty={dirty}
      saving={saving}
      error={error}
      onSave={() => void save().catch(() => undefined)}
      onCancel={discard}
    >
      <textarea
        className="project-config-instructions-input"
        value={draft}
        placeholder={"# 角色\n\n你是这个项目的长期 AI 助手……"}
        aria-label="项目指令"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p className="project-config-instructions-hint">仅在保存时写入项目；支持换行与 UTF-8。</p>
    </ProjectConfigDetailShell>
  );
}
