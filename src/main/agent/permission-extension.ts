import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../../shared/agent-ipc";
import { isDangerousTool, isSideEffectTool, summarizeToolInput } from "../../shared/pi-event-mapper";
import { BUILTIN_TOOL_NAMES } from "../security/McpSideEffectPolicy";

export interface PermissionBridge {
  /** 应返回「有效」权限（plan/ask 下为 readonly） */
  getPermissionMode: () => PermissionMode;
  /** 向 UI 请求审批；返回是否允许执行 */
  requestApproval: (info: {
    toolCallId: string;
    toolName: string;
    summary: string;
    detail?: string;
    dangerous: boolean;
  }) => Promise<boolean>;
}

/**
 * 产品自定义工具的审批；Pi 内置工具直接交给 SDK 执行。
 * 默认模式审批产品副作用工具，readonly 拦截，auto 放行。
 * plan/ask 由调用方通过 getPermissionMode 映射为 readonly。
 */
export function createPermissionExtension(bridge: PermissionBridge): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event) => {
      const toolName = event.toolName;
      if (BUILTIN_TOOL_NAMES.has(toolName)) return;
      const mode = bridge.getPermissionMode();
      if (mode === "auto") return;

      if (mode === "readonly") {
        if (isSideEffectTool(toolName, event.input)) {
          return {
            block: true,
            reason: "当前为只读/计划/仅问答模式，已阻止写操作与命令执行",
          };
        }
        return;
      }

      // default：危险或写工具需审批
      const input = event.input;
      const dangerous = isDangerousTool(toolName, input);
      if (!isSideEffectTool(toolName, input) && !dangerous) return;

      const { summary, detail } = summarizeToolInput(toolName, input);
      const approved = await bridge.requestApproval({
        toolCallId: event.toolCallId,
        toolName,
        summary,
        detail,
        dangerous,
      });

      if (!approved) {
        return { block: true, reason: "用户已拒绝该操作" };
      }
    });
  };
}
