import { useCallback } from "react";
import { PROJECT_NOTE_MAX_CHARS } from "@shared/project-notes";
import MarkdownNotesEditor from "@/components/workspace/MarkdownNotesEditor";

export default function ProjectNotes({ projectId, archived }: { projectId: string; archived: boolean }): React.JSX.Element {
  const read = useCallback(() => window.api!.projectNotes.read(projectId), [projectId]);
  const save = useCallback((content: string, expectedRevision: number) => window.api!.projectNotes.save({ projectId, content, expectedRevision }), [projectId]);
  return <MarkdownNotesEditor key={projectId} draftKey={`project-note-draft:${projectId}`} title="项目便签"
    hint="已保存内容供本项目的任务读取和修改；下一轮任务或下一次子代理派发时加载。多人或任务同时修改时会检查版本，避免覆盖。长内容会按上下文预算截断。"
    maxChars={PROJECT_NOTE_MAX_CHARS} read={read} saveNote={save} readOnly={archived} />;
}
