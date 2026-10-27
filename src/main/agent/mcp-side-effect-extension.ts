/**
 * McpSideEffectExtension — 在真实 MCP tool_call 前跑副作用门禁（P2）
 *
 * 挂在 pi `tool_call` 钩子（与 write/edit guard、permission 同一链路）：
 *  1. 解析工具名 → provider / shortTool
 *  2. McpSideEffectRegistry.evaluateToolCall
 *  3. 硬拒绝 → block
 *  4. 需审批 → 复用 UI 审批桥（auto 模式放行；readonly 拒写）
 *  5. 绝对路径越出 taskRoot → 额外硬拒绝（防止 unknown 写逃逸到共享盘）
 *
 * 非 MCP / 内置工具直接放行（由其它 extension 处理）。
 */
import { isAbsolute, resolve } from "node:path";
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
      const { identity, dangerous, sideEffect } = classification;
      let { decision } = classification;
      // The outer codemode tool has no blanket permission. Every native child reaches this hook.
      // Read-only mode rejects remote mutations and escape hatches as well as local file writes.
      if (bridge.getPermissionMode() === 'readonly' && sideEffect) {
        return { block: true, reason: '当前为只读模式，已阻止 MCP 写入或其他副作用' };
      }

      // 危险工具强制审批（escape hatch 语义）：即使 provider 策略放行也要求审批
      // （auto 权限模式仍放行，与既有 escape hatch 的 auto 例外一致）
      if (dangerous) {
        decision = {
          ...decision,
          requiresApproval: true,
          reason: `危险 MCP 工具强制审批：${identity.providerId}/${identity.shortToolName}`,
        };
      }
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


      // 绝对路径必须落在 taskRoot 或已授权写 grant 内；未授权外部路径走同一外部写授权
      // （相对路径交给 MCP server / roots）

      if (decision.isLocalWrite && decision.paths.length > 0 && bridge.taskRoot) {
        const filePolicy =
          bridge.getPolicy?.() ??
          new TaskFileAccessPolicy({
            taskId: bridge.taskId,
            taskRoot: bridge.taskRoot,
          });
        for (const raw of decision.paths) {
          if (!isAbsolute(raw) && !/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith("\\\\")) {
            continue;
          }
          const abs = resolve(raw);
          const d = filePolicy.decide("write", abs);
          if (d.allowed) continue;

          // 外部绝对路径：有授权桥 → 走同一 external-write 审批；无桥保持旧硬拒
          if (!bridge.requestExternalWriteApproval || !bridge.getPermissionMode) {
            console.warn(
              `[McpSideEffect] 越界路径硬拒绝（无授权桥）：provider=${identity.providerId} tool=${identity.shortToolName} path=${abs}`,
            );
            return {
              block: true,
              reason: `MCP 本地写路径越出任务目录：${abs}（taskRoot=${bridge.taskRoot}）`,
            };
          }
          const mode = bridge.getPermissionMode();
          if (mode === "readonly") {
            return {
              block: true,
              reason: `当前为只读模式，已阻止 MCP 本地写操作（${abs}）`,
            };
          }
          if (mode === "auto") continue;

          const idx = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
          const dir = idx > 0 ? abs.slice(0, idx) : abs;
          const approval = await bridge.requestExternalWriteApproval({
            taskId: bridge.taskId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            targetPath: abs,
            taskRoot: bridge.taskRoot,
            canonicalDir: dir,
            summary: `${identity.providerId}/${identity.shortToolName} 写入：${abs}`,
            detail: `MCP 工具尝试写入任务工作目录之外的位置。批准前请确认该位置可信。`,
          });
          if (approval.kind === "deny") {
            return {
              block: true,
              reason: `用户拒绝了 MCP 外部写入授权（${abs}）`,
            };
          }
          // allow-once / allow-task-dir：本次放行
        }
      }

      // 硬拒绝（none / read-only write）
      if (!decision.allowed && !decision.requiresApproval) {
        console.warn(
          `[McpSideEffect] 硬拒绝：${identity.providerId}/${identity.shortToolName} — ${decision.reason}`,
        );
        return { block: true, reason: decision.reason };
      }

      // A native, explicitly annotated read-only tool with matching read semantics needs no
      // mutation approval in read-only mode. Unknown/ambiguous tools remain conservative.
      if (bridge.getPermissionMode() === 'readonly' && decision.allowed && !sideEffect
        && classification.clearlyReadonly
        && pi.getAllTools?.().find(tool => tool.name === event.toolName)?.annotations?.readOnlyHint === true) return;

      if (!decision.requiresApproval) return;

      const mode = bridge.getPermissionMode();
      if (mode === "auto") return;

      if (mode === "readonly" && decision.isLocalWrite) {
        return {
          block: true,
          reason: "当前为只读/计划/仅问答模式，已阻止 MCP 本地写操作",
        };
      }

      const pathHint =
        decision.paths.length > 0 ? `路径：${decision.paths.slice(0, 3).join(", ")}` : undefined;
      const approved = await bridge.requestApproval({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        summary: `MCP ${identity.providerId}/${identity.shortToolName}`,
        detail: [decision.reason, pathHint].filter(Boolean).join("\n"),
        dangerous: decision.isLocalWrite,
      });

      if (!approved) {
        return { block: true, reason: "用户已拒绝该 MCP 操作" };
      }
    });
  };
}
