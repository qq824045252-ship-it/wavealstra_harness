import type { Attachment } from "@/types";
import type { RefFileItem } from "@/lib/refTaskArtifacts";
import type { RefTaskItem } from "@/lib/taskReference";

export interface ComposerAttachedSkill {
  id: string;
  name: string;
  command: string;
  icon?: string;
}

export interface ComposerAttachedMcp {
  name: string;
  endpoint?: string;
  transport?: string;
}

/**
 * 尚未发送的 composer 内容。只保存在 renderer 当前生命周期内：
 * 切换 Task / 首页后可恢复，但应用重启后不自动重放未发送内容。
 */
export interface TaskComposerDraft {
  text: string;
  attachments: Attachment[];
  attachedSkills: ComposerAttachedSkill[];
  attachedMcps: ComposerAttachedMcp[];
  refFiles: RefFileItem[];
  refTasks: RefTaskItem[];
}

const drafts = new Map<string, TaskComposerDraft>();

export function composerDraftScope(
  variant: "home" | "chat" | "project",
  activeTaskId: string | null,
): string {
  if (variant === "chat") return activeTaskId ? `task:${activeTaskId}` : "task:new";
  return `surface:${variant}`;
}

export function emptyTaskComposerDraft(): TaskComposerDraft {
  return {
    text: "",
    attachments: [],
    attachedSkills: [],
    attachedMcps: [],
    refFiles: [],
    refTasks: [],
  };
}

function hasContent(draft: TaskComposerDraft): boolean {
  return Boolean(
    draft.text ||
      draft.attachments.length ||
      draft.attachedSkills.length ||
      draft.attachedMcps.length ||
      draft.refFiles.length ||
      draft.refTasks.length,
  );
}

function cloneDraft(draft: TaskComposerDraft): TaskComposerDraft {
  return {
    text: draft.text,
    attachments: [...draft.attachments],
    attachedSkills: [...draft.attachedSkills],
    attachedMcps: [...draft.attachedMcps],
    refFiles: [...draft.refFiles],
    refTasks: [...draft.refTasks],
  };
}

export function saveTaskComposerDraft(scope: string, draft: TaskComposerDraft): void {
  if (!hasContent(draft)) {
    drafts.delete(scope);
    return;
  }
  drafts.set(scope, cloneDraft(draft));
}

export function loadTaskComposerDraft(scope: string): TaskComposerDraft {
  const draft = drafts.get(scope);
  return draft ? cloneDraft(draft) : emptyTaskComposerDraft();
}

export function clearTaskComposerDraft(scope: string): void {
  drafts.delete(scope);
}

/** 测试专用：每个 renderer 进程正常只会创建一份缓存。 */
export function clearAllTaskComposerDrafts(): void {
  drafts.clear();
}
