import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import { WORKSPACE_NOTE_MAX_CHARS } from "../../shared/workspace-notes";
import type { WorkspaceNotesService } from "./WorkspaceNotesService";

export function createWorkspaceNotesExtension(bridge: {
  service: WorkspaceNotesService;
  resolveWorkspaceId: () => string | null;
  getPermissionMode: () => PermissionMode;
}): ExtensionFactory {
  const workspaceId = () => {
    const id = bridge.resolveWorkspaceId();
    if (!id) throw new Error("当前任务未绑定空间，无法访问空间便签");
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
      name: "workspace_notes_read", label: "空间便签 · 读取",
      description: "读取当前任务直接所属空间的完整 Markdown 便签和 revision。任务之间共享；不按磁盘路径猜测空间，不能指定其他空间。修改前先读取最新版本。",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => result(() => bridge.service.read(workspaceId())),
    });
    pi.registerTool({
      name: "workspace_notes_save", label: "空间便签 · 保存",
      description: "保存当前空间共享便签。传入完整 Markdown content 和读取所得 expectedRevision；保留无关内容。冲突时重新读取并合并，不得盲目覆盖。空字符串清空。只读模式或归档空间不可修改。",
      parameters: Type.Object({ content: Type.String({ maxLength: WORKSPACE_NOTE_MAX_CHARS }), expectedRevision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
      execute: async (_id: string, params: { content: string; expectedRevision: number }) => result(() => {
        if (bridge.getPermissionMode() === "readonly") throw new Error("当前为只读权限模式，不能修改空间便签");
        return bridge.service.save({ workspaceId: workspaceId(), content: params.content, expectedRevision: params.expectedRevision });
      }),
    });
  };
}
