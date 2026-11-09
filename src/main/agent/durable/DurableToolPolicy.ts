import { TOOL_NOT_STARTED_MEMO } from "./DurableToolOutcome";
import { workShellRead } from "../work/WorkShellRead";
import { resolve } from "node:path";
import { z } from "zod";
import type { Context } from "@earendil-works/chord/context";
import type { HookApi, ToolExecutionResult, ToolHookCall, ToolHooks } from "@earendil-works/pi-durable";
import type { PermissionMode } from "../../../shared/agent-ipc";
import { isDangerousTool, isSideEffectTool, summarizeToolInput } from "../../../shared/pi-event-mapper";
import { classifyMcpToolCall } from "../../security/McpSideEffectPolicy";
import { isManagedToolProvider } from "../../../shared/professional-tools";
import { TaskFileAccessPolicy } from "../../security/TaskFileAccessPolicy";
import type { ConversationInteractionService } from "../ConversationInteractionService";
import type { ExecutionFailureRepository } from "../ExecutionFailureRepository";
import type { ExecutionAttemptRepository } from "../ExecutionAttemptRepository";
import type { SessionToolApprovalRequest } from "../SessionApprovalBridge";
import { currentDurableInvocation, durableExecutionContext } from "./DurableExecutionContext";
import { DurableSubagentIdentity } from "./DurableSubagents";
import { durableMcpToolName } from "./DurableMcp";
import { effectIntentSchema, effectOperationId, prepareFileEffect, verifyFileEffect, type EffectEvidence, type ExternalEffectRecovery } from "./DurableEffectRecovery";

function isArguments(value: unknown): value is ToolHookCall["arguments"] {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function policyCall(call: ToolHookCall): ToolHookCall {
  if (call.name !== "mcp_call_tool") return call;
  const { server, tool, arguments: args } = call.arguments;
  if (typeof server !== "string" || !server || typeof tool !== "string" || !tool || !isArguments(args)) {
    throw new Error("MCP 调用缺少真实工具身份与参数");
  }
  return { ...call, name: durableMcpToolName(server, tool), arguments: args };
}
const mcpReadTools = new Set(["mcp_list_tools", "mcp_list_resources", "mcp_read_resource", "mcp_status"]);
const jsonArguments = z.record(z.string(), z.json());

export interface DurableToolPolicyOptions {
  taskId: string;
  taskRoot: string;
  getPermissionMode: () => PermissionMode;
  interactions: ConversationInteractionService;
  failures: ExecutionFailureRepository;
  attempts: ExecutionAttemptRepository;
  providerIds?: readonly string[];
  getPolicy?: () => TaskFileAccessPolicy;
  ensureRuntimeReady?: (providerId: string) => Promise<void>;
  toolAllowed?: (name: string) => boolean;
  effectRecovery?: ExternalEffectRecovery;
  admitWorkAction?: (input: { operationId: string; actionKind: string; paths: string[] }) => string | undefined;
  settleWorkAction?: (operationId: string, outcome: "consumed" | "released" | "unknown") => void;
}

/** Native ToolTask hooks run for model tools, child agents, and Code Mode's nested calls. */
export function createDurableToolPolicy(options: DurableToolPolicyOptions): {
  hooks: Partial<ToolHooks>;
  requestApproval: (request: SessionToolApprovalRequest) => Promise<boolean>;
} {
  const identity = async (api: HookApi, context: Context, call: ToolHookCall) => {
    const stored = await api.memo("mybuddy.execution-context", context);
    if (stored) return durableExecutionContext(options.taskId, api, context);
    const rootCallId = call.id.split("/")[0];
    const entries = await api.entries({ order: "descending" }, 64, undefined, context);
    const owner = entries.items.find(entry => entry.model?.some(message => message.role === "assistant"
      && message.content.some(block => block.type === "toolCall" && block.id === rootCallId)));
    return durableExecutionContext(options.taskId, api, context, owner ? `durable-${owner.id}` : undefined);
  };
  const approve = async (request: SessionToolApprovalRequest, api: Pick<HookApi, "memo" | "taskId" | "conversationId">, context: Context) => {
    const mode = options.getPermissionMode();
    if (mode === "auto") return true;
    if (mode === "readonly") return false;
    const execution = await durableExecutionContext(options.taskId, api, context);
    const answer = await options.interactions.requestDurable(execution, {
      kind: "confirm", title: `允许执行 ${request.toolName}？`,
      description: [request.summary, request.detail].filter(Boolean).join("\n"),
    }, { key: `approval:${request.toolCallId}`, signal: context.abortSignal });
    return answer === true;
  };
  return {
    requestApproval: async request => {
      const active = currentDurableInvocation();
      if (!active || active.execution.taskId !== options.taskId) throw new Error("审批缺少当前任务的持久执行身份");
      if (options.getPermissionMode() === "readonly") return false;
      if (request.toolCallId !== active.native.callId) throw new Error("工具内部审批身份与当前原生动作不匹配");
      return approve(request, active.native, active.context);
    },
    hooks: {
      beforeTool: async (call, api, context) => {
        const originalCall = call;
        const refuse = (reason: string) => {
          const summary = summarizeToolInput(call.name, call.arguments);
          return { block: `${reason}${summary.summary ? `（${summary.summary}）` : ""}` };
        };
        if (options.toolAllowed && !options.toolAllowed(call.name)) return refuse(`当前任务未授权工具：${call.name}`);
        call = policyCall(call);
        if (options.toolAllowed && !options.toolAllowed(call.name)) return refuse(`当前任务未授权工具：${call.name}`);
        await identity(api, context, call);
        // The built-in Code Mode VM has no ambient filesystem/network access. Its
        // executeTool leaves each enter this hook with their own exact identity.
        if (originalCall.name === "codemode") return undefined;
        const mode = options.getPermissionMode();
        const mcp = mcpReadTools.has(call.name) ? null : classifyMcpToolCall(call.name, call.arguments, options.providerIds);
        const shellRead = workShellRead(call.name, call.arguments);
        const sideEffect = !shellRead && (mcp?.sideEffect ?? isSideEffectTool(call.name, call.arguments));
        const dangerous = mcp?.dangerous ?? isDangerousTool(call.name, call.arguments);
        if (mode === "readonly" && (sideEffect || dangerous)) return refuse("当前为只读/计划/仅问答模式，已阻止写操作与命令执行");
        if (mcp && !mcp.decision.allowed && !mcp.decision.requiresApproval) return refuse(mcp.decision.reason);

        if (mcp && options.ensureRuntimeReady && isManagedToolProvider(mcp.identity.providerId)) {
          await options.ensureRuntimeReady(mcp.identity.providerId);
        }
        const declaredPath = typeof call.arguments.path === "string" ? call.arguments.path
          : typeof call.arguments.file_path === "string" ? call.arguments.file_path : undefined;
        const paths = mcp?.decision.isLocalWrite ? mcp.decision.paths
          : ["read", "write", "edit", "glob", "grep", "ls"].includes(call.name) && declaredPath ? [declaredPath] : [];
        const child = (await api.snapshot(DurableSubagentIdentity, api.conversationId, context))?.value;
        if (child && child.taskId !== options.taskId) return { block: "子代理身份与宿主任务不一致" };
        const taskRoot = child?.workspace.cwd ?? options.taskRoot;
        const parentPolicy = options.getPolicy?.() ?? new TaskFileAccessPolicy({ taskId: options.taskId, taskRoot: options.taskRoot });
        const filePolicy = resolve(taskRoot) === resolve(options.taskRoot) ? parentPolicy : new TaskFileAccessPolicy({
          taskId: options.taskId, taskRoot, isolatedSourceRoots: [options.taskRoot],
          writeGrants: [...parentPolicy?.listWriteGrants() ?? []],
        });
        let externalPath: string | undefined;
        for (const path of paths) {
          const absolute = resolve(taskRoot, path);
          const access = filePolicy?.decide("write", absolute);
          if (access?.scope === "isolated-source") return refuse(access.reason);
          if (access && !access.allowed) externalPath = absolute;
        }
        // Code Mode and subagent containers grant nothing: each child reaches this hook itself.
        const needsApproval = sideEffect || dangerous || Boolean(mcp?.decision.requiresApproval) || Boolean(externalPath);
        const operationId = `tool:${api.conversationId}:${api.taskId}:${call.id}`;
        const actionKind = ["subagent", "subagent_steer"].includes(call.name) ? "delegate"
          : sideEffect || dangerous ? "workspace:write" : "workspace:read";
        if (mode !== "auto" && needsApproval) {
          const summary = summarizeToolInput(call.name, call.arguments);
          const allowed = await approve({ toolCallId: call.id, toolName: call.name, dangerous,
            summary: summary.summary, detail: [summary.detail, externalPath ? `工作目录之外的写入：${externalPath}` : undefined].filter(Boolean).join("\n"),
          }, api, context);
          if (!allowed) return { block: "用户已拒绝该操作" };
        }
        const admitWork = async () => {
          const denied = options.admitWorkAction?.({ operationId, actionKind, paths });
          if (denied) return denied;
          return undefined;
        };
        if (sideEffect || dangerous) {
          const execution = await durableExecutionContext(options.taskId, api, context);
          const priorIntent = await api.memo("mybuddy.effect-intent", context);
          let intent = priorIntent === undefined ? await prepareFileEffect(call, taskRoot) : effectIntentSchema.parse(priorIntent);
          const origin = originalCall.name === "mcp_call_tool" && typeof originalCall.arguments.server === "string" && typeof originalCall.arguments.tool === "string"
            ? { server: originalCall.arguments.server, tool: originalCall.arguments.tool } : undefined;
          const prepared = !intent && options.effectRecovery
            ? await options.effectRecovery.prepare(call.name, jsonArguments.parse(call.arguments), effectOperationId(execution.executionId, call.id), context, origin) : undefined;
          if (prepared) { intent = prepared.intent; call = { ...call, arguments: prepared.arguments }; }
          if (intent && priorIntent === undefined) await api.memo("mybuddy.effect-intent", intent, context);
          options.attempts.beginDurable({ ...execution, toolCallId: call.id, toolName: call.name,
            target: `durable-tool:${api.conversationId}:${api.taskId}`,
            verifierId: intent?.kind === "file" ? "durable-file-content" : intent?.kind === "receipt" ? "durable-business-receipt" : "durable-tool-result", verifierVersion: 1,
          });
          if (intent?.kind === "receipt") {
            const argumentsWithIdentity = { ...call.arguments, [intent.contract.idempotencyArgument]: intent.operationId };
            const blocked = await admitWork();
            if (blocked) return { block: blocked };
            return { arguments: jsonArguments.parse(originalCall.name === "mcp_call_tool"
              ? { ...originalCall.arguments, arguments: argumentsWithIdentity } : argumentsWithIdentity) };
          }
        }
        const blocked = await admitWork();
        if (blocked) return { block: blocked };
        return undefined;
      },
      afterTool: async (call, result, api, context) => {
        // The container owns no effect receipt; its leaves do.
        if (call.name === "codemode") return undefined;
        // Pi also reports validation failures here, before beforeTool or execution ran.
        try { call = policyCall(call); }
        catch { return undefined; }
        const interrupted = result.diagnostics?.find(item => ["interrupted", "aborted", "abandoned", "restart_limit"].includes(item.code ?? ""));
        const execution = await identity(api, context, call);
        const attempt = options.attempts.findDurable(execution, call.id);
        const mcp = mcpReadTools.has(call.name) ? null : classifyMcpToolCall(call.name, call.arguments, options.providerIds);
        const mayWrite = !workShellRead(call.name, call.arguments) && (mcp?.sideEffect ?? (isSideEffectTool(call.name, call.arguments) || isDangerousTool(call.name, call.arguments)));
        const savedIntent = await api.memo("mybuddy.effect-intent", context);
        const intent = savedIntent === undefined ? undefined : effectIntentSchema.parse(savedIntent);
        let evidence: EffectEvidence | undefined;
        if (attempt && intent) {
          if (intent.kind === "file") evidence = await verifyFileEffect(intent, context.abortSignal);
          else if (options.effectRecovery && options.toolAllowed?.(durableMcpToolName(intent.server, intent.contract.receiptTool)) !== false) evidence = await options.effectRecovery.verify(intent, context);
          else evidence = { status: "inconclusive", verifierId: "durable-business-receipt",
            canonicalTarget: `${intent.server}/${intent.tool}/${intent.operationId}`,
            expected: { operationId: intent.operationId, completed: intent.contract.completedValues },
            observed: { reason: "receipt-verifier-unavailable-or-not-authorized" }, checkedAt: Date.now() };
        }
        const proof = await api.memo(TOOL_NOT_STARTED_MEMO, context);
        const notStarted = proof !== null && typeof proof === "object" && !Array.isArray(proof)
          && proof.toolName === call.name && proof.callId === call.id && proof.taskId === api.taskId
          && proof.conversationId === api.conversationId && proof.phase === "validation";
        const reconciled = evidence?.status === "passed";
        const settlement = notStarted ? "released" : reconciled || (!evidence && !interrupted && !result.isError) ? "consumed" : mayWrite ? "unknown" : "released";
        options.settleWorkAction?.(`tool:${api.conversationId}:${api.taskId}:${call.id}`, settlement);
        if (attempt) {
          const status = notStarted ? "failed" : evidence?.status ?? (interrupted ? "inconclusive" : result.isError ? "failed" : "passed");
          options.attempts.settleDurable({ ...attempt, status, phase: "finished", finishedAt: Date.now(),
            transportStatus: result.isError ? "failed" : "succeeded", causeCode: reconciled ? undefined : evidence ? "effect-unverified" : interrupted?.code,
            recovery: status === "inconclusive" ? "requires-user-action" : undefined,
            verifierId: evidence?.verifierId ?? attempt.verifierId,
            // Business/file verification is used only when an explicit pre-execution intent exists.
            verification: { ...execution, attemptId: attempt.id, verifierId: evidence?.verifierId ?? attempt.verifierId, verifierVersion: 1,
              target: attempt.target, canonicalTarget: evidence?.canonicalTarget ?? attempt.target, status,
              expected: evidence?.expected ?? { successfulToolResponse: true }, observed: evidence?.observed ?? { isError: result.isError === true,
                diagnosticCodes: (result.diagnostics ?? []).map(item => item.code ?? "") }, checkedAt: Date.now(),
              ...(!reconciled && interrupted?.code ? { causeCode: interrupted.code } : {}),
            },
          });
          if (status !== "inconclusive") options.failures.resolveMatching(options.taskId, { target: attempt.target, causeCodes: ["application-restarted", "durable-tool-interrupted", "effect-unverified"] });
        }
        if (evidence?.status === "passed" && (interrupted || result.isError)) return { output: [{ type: "text", text: "已通过回读确认原操作完成，未重复执行。" }],
          details: { recovery: { verifierId: evidence.verifierId, checkedAt: evidence.checkedAt, status: "passed" } } };
        if (evidence && attempt && !reconciled) {
          options.failures.recordIfAbsent({ ...execution, causeCode: "effect-unverified", phase: "verify", recovery: "requires-user-action", sideEffects: "unknown",
            target: attempt.target, message: "工具结果尚未通过内容或业务回执核验", nextAction: "检查核验证据和实际外部状态，确认前不要重复提交原操作。" });
          return { ...result, isError: true, output: [...(result.output ?? []), { type: "text", text: "核验未确认原操作完成；没有自动重发。" }],
            details: { recovery: { verifierId: evidence.verifierId, checkedAt: evidence.checkedAt, status: evidence.status } } };
        }
        if (!interrupted || notStarted) return undefined;
        options.interactions.cancelExecution(execution.executionId, "当前工具执行已结束");
        if (!(mcp?.sideEffect ?? isSideEffectTool(call.name, call.arguments))) return undefined;
        options.failures.recordIfAbsent({ ...execution, causeCode: "durable-tool-interrupted", phase: "recover",
          recovery: "requires-user-action", sideEffects: "unknown", target: `durable-tool:${api.conversationId}:${api.taskId}`,
          message: `${call.name} 已中断，外部操作结果尚未确认：${interrupted.message}`,
          nextAction: "先回读文件、业务回执或外部状态。确认结果前不要重复提交同一副作用操作。",
        });
        return undefined as ToolExecutionResult | undefined;
      },
    },
  };
}
