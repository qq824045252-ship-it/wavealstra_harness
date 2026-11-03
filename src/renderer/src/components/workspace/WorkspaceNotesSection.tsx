import { useCallback } from "react";
import { WORKSPACE_NOTE_MAX_CHARS } from "@shared/workspace-notes";
import MarkdownNotesEditor from "./MarkdownNotesEditor";

export default function WorkspaceNotesSection({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const read = useCallback(() => window.api!.workspace.notes.read(workspaceId), [workspaceId]);
  const save = useCallback((content: string, expectedRevision: number) => window.api!.workspace.notes.save({ workspaceId, content, expectedRevision }), [workspaceId]);
  return <MarkdownNotesEditor key={workspaceId} draftKey={`workspace-note-draft:${workspaceId}`} title="空间便签"
    hint="本空间的任务可读取和修改便签；下级空间任务及子代理可读取。下一轮任务或下一次派发时加载，长内容按上下文预算截断；同时修改会检查版本，避免覆盖。"
    maxChars={WORKSPACE_NOTE_MAX_CHARS} read={read} saveNote={save} />;
}
