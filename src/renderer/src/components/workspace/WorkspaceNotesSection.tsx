import { useCallback } from "react";
import { WORKSPACE_NOTE_MAX_CHARS } from "@shared/workspace-notes";
import MarkdownNotesEditor from "./MarkdownNotesEditor";

export default function WorkspaceNotesSection({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const read = useCallback(() => window.api!.workspace.notes.read(workspaceId), [workspaceId]);
  const save = useCallback((content: string, expectedRevision: number) => window.api!.workspace.notes.save({ workspaceId, content, expectedRevision }), [workspaceId]);
  return <MarkdownNotesEditor key={workspaceId} draftKey={`workspace-note-draft:${workspaceId}`} title="空间便签"
    hint="已保存内容供本空间及下级空间的任务、子代理读取，下一轮任务或下一次派发时加载；长内容会按上下文预算截断。"
    maxChars={WORKSPACE_NOTE_MAX_CHARS} read={read} saveNote={save} />;
}
