/** MCP runtime readiness hook. Application side-effect approvals are retired. */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../../shared/agent-ipc";
import type { ExternalWriteApprovalRequest, ExternalWriteDecision } from "../../shared/external-write";
import { isManagedToolProvider } from "../../shared/professional-tools";
import {
  classifyMcpToolCall,
  getDefaultMcpSideEffectRegistry,
  MANAGED_RUNTIME_DANGEROUS_TOOLS,
  type McpSideEffectRegistry,
} from "../security/McpSideEffectPolicy";
import { TaskFileAccessPolicy } from "../security/TaskFileAccessPolicy";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";

export interface McpSideEffectBridge {
  taskId: string;
  taskRoot: string;
  /** Exact MCP server ids enabled for this session; disambiguates normalized server/tool names. */
  providerIds?: readonly string[];
  getPermissionMode: () => PermissionMode;
  requestApproval: (info: {
    toolCallId: string;
    toolName: string;
    summary: string;
    detail?: string;
    dangerous: boolean;
  }) => Promise<boolean>;
  /** External file authorization for MCP tools; Pi builtins bypass this extension. */
  requestExternalWriteApproval?: (req: ExternalWriteApprovalRequest) => Promise<ExternalWriteDecision>;
  /** 每次判定时读取最新 policy（含 write grants） */
  getPolicy?: () => TaskFileAccessPolicy;
  /** 可注入测试 registry；默认 getDefaultMcpSideEffectRegistry() */
  registry?: McpSideEffectRegistry;
  /**
   * 首次 MCP tool call 的 runtime fallback：managed provider（freecad 等）未 ready 时
   * 先 ensureReady（阻塞该调用；防 race / Tag 切换 / runtime crash 后自动恢复）。
   * readiness 只做无业务副作用的 bridge 探测，不调用业务 tool。
   */
  ensureRuntimeReady?: (providerId: string) => Promise<void>;
  /**
   * 危险工具（providerId → 工具名集合）：即使 provider 策略放行也强制审批
   * （escape hatch 语义，如 freecad 的 execute_python 任意代码执行）。
   */
  dangerousTools?: ReadonlyMap<string, ReadonlySet<string>>;
  resolveExecutionContext?: () => ConversationExecutionContext | undefined;
  executionFailures?: ExecutionFailureRepository;
}

export function createMcpSideEffectExtension(bridge: McpSideEffectBridge): ExtensionFactory {
  const registry = bridge.registry ?? getDefaultMcpSideEffectRegistry();

  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event) => {
      const classification = classifyMcpToolCall(
        event.toolName, event.input, bridge.providerIds, registry, bridge.dangerousTools ?? MANAGED_RUNTIME_DANGEROUS_TOOLS,
      );
      if (!classification) return;
      const { identity } = classification;
      // Readiness and access permissions do not depend on product plan lifecycle.
      if (bridge.ensureRuntimeReady && isManagedToolProvider(identity.providerId)) {
        try {
          await bridge.ensureRuntimeReady(identity.providerId);
          const active = bridge.resolveExecutionContext?.();
          if (active) bridge.executionFailures?.resolveMatching(active.taskId, { target: `mcp-runtime:${identity.providerId}`, causeCodes: ["mcp-runtime-not-ready"] });
        } catch (error) {
          const active = bridge.resolveExecutionContext?.();
          if (active) bridge.executionFailures?.record({ ...active, causeCode: "mcp-runtime-not-ready", phase: "prepare", recovery: "recoverable", sideEffects: "none",
            target: `mcp-runtime:${identity.providerId}`, message: `MCP runtime ${identity.providerId} is not ready: ${error instanceof Error ? error.message : String(error)}`,
            nextAction: "Restart or reconnect the MCP runtime, then retry after readiness succeeds." });
          return {
            block: true,
            reason: `MCP runtime 未就绪：${identity.providerId} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      }

      // Availability is operational state, not an application approval policy.
    });
  };
}
