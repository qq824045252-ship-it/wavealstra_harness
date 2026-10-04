import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import type { GadgetService } from "./GadgetService";

export interface GadgetAgentBridge {
  taskId: string;
  resolveWorkspaceId: () => string | null;
  service: GadgetService;
  getPermissionMode: () => PermissionMode;
  requestApproval: (info: {
    toolCallId: string;
    toolName: string;
    summary: string;
    detail?: string;
    dangerous: boolean;
  }) => Promise<boolean>;
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `[gadget_create] ${message}` }],
    isError: true as const,
    details: { error: message } as Record<string, unknown>,
  };
}

function assertRenderableGadgetHtml(html: string): void {
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*\bcontent\s*=\s*["'][^"']*file:\/\//i.test(html)
    || /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*file:\/\/[^"']*["'][^>]*http-equiv\s*=\s*["']?refresh/i.test(html)) {
    throw new Error("Gadget 必须包含可直接渲染的 HTML，不能用 file:// 跳转页代替内容");
  }
}

/** Task-bound native tool: the Agent can create only a real Task Gadget or that task's bound Workspace Gadget. */
export function createGadgetAgentExtension(bridge: GadgetAgentBridge): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "gadget_create",
      label: "Gadget · 创建工具",
      description:
        "创建一个可持续运行、可重复打开的自包含 HTML Gadget。html 必须是可直接渲染的最终界面，不能只写 file:// 跳转页。默认绑定当前 Task；当任务属于 Workspace 且用户明确要求工作空间长期工具时，可把 scope 设为 workspace。",
      promptSnippet: "gadget_create(name, html, description?, scope?) — 为当前任务或其 Workspace 创建 HTML Gadget",
      parameters: Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 120 }),
          html: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
          description: Type.Optional(Type.String({ maxLength: 1000 })),
          scope: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("workspace")])),
        },
        { additionalProperties: false },
      ),
      execute: async (
        toolCallId: string,
        params: { name: string; html: string; description?: string; scope?: "task" | "workspace" },
      ) => {
        try {
          assertRenderableGadgetHtml(params.html);
          const workspaceId = bridge.resolveWorkspaceId();
          if (params.scope === "workspace" && !workspaceId) throw new Error("当前任务未绑定 Workspace，不能创建 Workspace Gadget");
          const scope = params.scope === "workspace"
            ? { type: "workspace" as const, workspaceId: workspaceId! }
            : { type: "task" as const, taskId: bridge.taskId };
          const permissionMode = bridge.getPermissionMode();
          if (permissionMode === "readonly") throw new Error("当前为只读/计划/仅问答模式，不能创建 Gadget");
          if (permissionMode !== "auto") {
            const approved = await bridge.requestApproval({
              toolCallId,
              toolName: "gadget_create",
              summary: `创建 ${scope.type === "workspace" ? "Workspace" : "Task"} Gadget：${params.name.trim() || "未命名"}`,
              detail: `Gadget 将写入 MyBuddy 的独立持久存储，并绑定到当前${scope.type === "workspace" ? "工作空间" : "任务"}。`,
              dangerous: false,
            });
            if (!approved) throw new Error("用户已拒绝创建 Gadget");
          }
          const gadget = bridge.service.create({
            name: params.name,
            description: params.description,
            scope,
            createdByTaskId: bridge.taskId,
            entry: "index.html",
            files: [{ path: "index.html", content: params.html, encoding: "utf8" }],
            metadata: { createdBy: "agent-tool" },
          });
          return {
            content: [{ type: "text" as const, text: `已创建 ${scope.type === "workspace" ? "Workspace" : "Task"} Gadget「${gadget.name}」（id=${gadget.id}）。用户可在 Gadgets 区域打开、停止或迁移作用域。` }],
            details: { gadgetId: gadget.id, scope: gadget.scope, name: gadget.name } as Record<string, unknown>,
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    });
  };
}
