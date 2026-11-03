import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import { PROJECT_NOTE_MAX_CHARS } from "../../shared/project-notes";
import type { ProjectNotesService } from "./ProjectNotesService";

export function createProjectNotesExtension(bridge: {
  service: ProjectNotesService;
  resolveProjectId: () => string | null;
  getPermissionMode: () => PermissionMode;
}): ExtensionFactory {
  const projectId = () => {
    const id = bridge.resolveProjectId();
    if (!id) throw new Error("当前任务未绑定项目，无法访问项目便签");
    return id;
  };
  const result = (run: () => unknown): { content: { type: "text"; text: string }[]; details: unknown; isError?: boolean } => {
    try {
      const note = run();
      return { content: [{ type: "text" as const, text: JSON.stringify(note) }], details: { note } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
    }
  };
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "project_notes_read", label: "项目便签 · 读取",
      description: "读取当前任务所属项目的完整 Markdown 便签和 revision。任务之间共享；不能指定其他项目。修改前先读取最新版本。",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => result(() => bridge.service.read(projectId())),
    });
    pi.registerTool({
      name: "project_notes_save", label: "项目便签 · 保存",
      description: "保存当前项目共享便签。传入完整 Markdown content 和读取所得 expectedRevision；保留无关内容。冲突时重新读取并合并，不得盲目覆盖。空字符串清空。只读模式或归档项目不可修改。",
      parameters: Type.Object({ content: Type.String({ maxLength: PROJECT_NOTE_MAX_CHARS }), expectedRevision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
      execute: async (_id: string, params: { content: string; expectedRevision: number }) => result(() => {
        if (bridge.getPermissionMode() === "readonly") throw new Error("当前为只读权限模式，不能修改项目便签");
        return bridge.service.save({ projectId: projectId(), content: params.content, expectedRevision: params.expectedRevision });
      }),
    });
  };
}
