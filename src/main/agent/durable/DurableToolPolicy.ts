import { TOOL_NOT_STARTED_MEMO } from "./DurableToolOutcome";
import { readDesktopOperationOutcome } from "../DesktopOperationOutcome";
import { isNativeNotStarted, nativeAssistantEntry } from "./DurableToolLifecycle";
import { workShellRead } from "../work/WorkShellRead";
import { z } from "zod";
import type { Context } from "@earendil-works/chord/context";
import type { HookApi, JsonObject, ToolExecutionResult, ToolHookCall, ToolHooks } from "@earendil-works/pi-durable";
import type { PermissionMode } from "../../../shared/agent-ipc";
import { OFFICE_USE_TOOLS } from "../../../shared/office-use";
import { CAD_USE_TOOLS } from "../../../shared/cadcraft";
import { DRAWIO_USE_TOOLS } from "../../../shared/drawio-use";
import { isDangerousTool, isSideEffectTool, summarizeToolInput } from "../../../shared/pi-event-mapper";
import { classifyMcpToolCall } from "../../security/McpSideEffectPolicy";
import { isManagedToolProvider } from "../../../shared/professional-tools";
import { TaskFileAccessPolicy } from "../../security/TaskFileAccessPolicy";
import type { ConversationInteractionService } from "../ConversationInteractionService";
import type { ExecutionFailureRepository } from "../ExecutionFailureRepository";
import type { ExecutionAttemptRepository } from "../ExecutionAttemptRepository";
import type { SessionToolApprovalRequest } from "../SessionApprovalBridge";
import { nativeExecutionOperationId, nativeExecutionReceiptSchema, nativeFileReadAttemptSchema, type NativeExecutionReceipt } from "../../../shared/native-execution-receipt";
import { collectRuntimeMaterialEvidence } from "../RuntimeMaterialEvidence";
import { FILE_MUTATION_TARGET_MEMO, type FileMutationTarget } from "../../platform/bash-workspace-path";
import { NATIVE_FILE_READ_ATTEMPT } from "./DurableFileReadEvidence";
import { durableExecutionContext } from "./DurableExecutionContext";
import { DurableSubagentIdentity } from "./DurableSubagents";
import { durableMcpToolName } from "./DurableMcp";
import { isNativeShell } from "./DurableShellTerminal";
import { BASH_INACTIVITY_MESSAGE } from "../../platform/bash-inactivity";
import { effectIntentSchema, effectOperationId, isNativeFileMutation, NATIVE_FILE_EVIDENCE_MEMO, NATIVE_FILE_INTENT_MEMO,
  prepareFileEffect, readEffectIntent, verifyFileEffect, type EffectEvidence, type EffectIntent, type ExternalEffectRecovery } from "./DurableEffectRecovery";

function isArguments(value: unknown): value is ToolHookCall["arguments"] {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function policyCall(call: ToolHookCall): ToolHookCall {
  if (call.name === "pstack_decision_append" || call.name === "pstack_eval_save") return { ...call, name: "write" };
  if (call.name !== "mcp_call_tool") return call;
  const { server, tool, arguments: args } = call.arguments;
  if (typeof server !== "string" || !server || typeof tool !== "string" || !tool || !isArguments(args)) {
    throw new Error("MCP 调用缺少真实工具身份与参数");
  }
  return { ...call, name: durableMcpToolName(server, tool), arguments: args };
}
const mcpReadTools = new Set(["mcp_list_tools", "mcp_list_resources", "mcp_read_resource", "mcp_status"]);
const jsonArguments = z.record(z.string(), z.json());
const receiptMemo = "mybuddy.native-execution-receipt.v1";
const receiptCheckpointSchema = z.object({
  receipt: nativeExecutionReceiptSchema,
  verification: z.object({ canonicalTarget: z.string(), expected: jsonArguments, observed: jsonArguments }),
  effectStatus: z.enum(["passed", "failed", "inconclusive"]).optional(),
});
const unconfirmedBrowserResult = z.object({
  outcome: z.object({ dispatch: z.literal("dispatched"), effect: z.literal("unknown") }),
});

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
  settleWorkAction?: (receipt: NativeExecutionReceipt) => void;
}

/** Native ToolTask hooks run for model tools, child agents, and Code Mode's nested calls. */
export function createDurableToolPolicy(options: DurableToolPolicyOptions): {
  hooks: Partial<ToolHooks>;
  requestApproval: (request: SessionToolApprovalRequest) => Promise<boolean>;
} {
  const identity = async (api: HookApi, context: Context, call: ToolHookCall) => {
    const stored = await api.memo("mybuddy.execution-context", context);
    if (stored) return durableExecutionContext(options.taskId, api, context);
    const assistant = nativeAssistantEntry(api.taskId, String(api.conversationId));
    if (assistant !== undefined) return durableExecutionContext(options.taskId, api, context, `durable-${assistant}`);
    const rootCallId = call.id.split("/")[0];
    const entries = await api.entries({ order: "descending" }, 64, undefined, context);
    const owner = entries.items.find(entry => entry.model?.some(message => message.role === "assistant"
      && message.content.some(block => block.type === "toolCall" && block.id === rootCallId)));
    return durableExecutionContext(options.taskId, api, context, owner ? `durable-${owner.id}` : undefined);
  };
  return {
    requestApproval: async _request => true,
    hooks: {
      beforeTool: async (call, api, context) => {
        const originalCall = call;
        const refuse = (reason: string) => {
          const summary = summarizeToolInput(call.name, call.arguments);
          return { block: `${reason}${summary.summary ? `（${summary.summary}）` : ""}` };
        };
        if (options.toolAllowed && !options.toolAllowed(call.name)) return refuse(`当前任务工具不可用：${call.name}`);
        call = policyCall(call);
        if (options.toolAllowed && !options.toolAllowed(call.name)) return refuse(`当前任务工具不可用：${call.name}`);
        const executionIdentity = await identity(api, context, call);
        // Retire only the old approval identity for this exact native call. Normal
        // request_user_input questions (even with the same title) are untouched.
        options.interactions.cancelDurable(executionIdentity, `approval:${call.id}`, "应用工具审批已退役，继续原执行");
        // The built-in Code Mode VM has no ambient filesystem/network access. Its
        // executeTool leaves each enter this hook with their own exact identity.
        if (originalCall.name === "codemode") return undefined;
        const mcp = mcpReadTools.has(call.name) ? null : classifyMcpToolCall(call.name, call.arguments, options.providerIds);
        const shellRead = workShellRead(call.name, call.arguments);
        const sideEffect = !shellRead && (mcp?.sideEffect ?? isSideEffectTool(call.name, call.arguments));
        const dangerous = mcp?.dangerous ?? isDangerousTool(call.name, call.arguments);
        if (mcp && options.ensureRuntimeReady && isManagedToolProvider(mcp.identity.providerId)) {
          await options.ensureRuntimeReady(mcp.identity.providerId);
        }
        const declaredPath = typeof call.arguments.path === "string" ? call.arguments.path
          : typeof call.arguments.file_path === "string" ? call.arguments.file_path : undefined;
        const paths = mcp?.decision.isLocalWrite ? mcp.decision.paths
          : ["read", "write", "edit", "glob", "grep", "ls", OFFICE_USE_TOOLS.documentCreate,
            ...Object.values(CAD_USE_TOOLS), ...Object.values(DRAWIO_USE_TOOLS)].includes(call.name) && declaredPath ? [declaredPath] : [];
        const child = (await api.snapshot(DurableSubagentIdentity, api.conversationId, context))?.value;
        if (child && child.taskId !== options.taskId) return { block: "子代理身份与宿主任务不一致" };
        const taskRoot = child?.workspace.cwd ?? options.taskRoot;
        const operationId = nativeExecutionOperationId({ conversationId: api.conversationId, toolTaskId: api.taskId, callId: call.id });
        // Native children retain this task identity and re-enter this hook for every leaf tool.
        // Starting/steering a local child grants no separate business authority.
        const actionKind = sideEffect || dangerous ? "workspace:write" : "workspace:read";
        const admitWork = async () => {
          const denied = options.admitWorkAction?.({ operationId, actionKind, paths });
          if (denied) return denied;
          return undefined;
        };
        if (sideEffect || dangerous) {
          const execution = await durableExecutionContext(options.taskId, api, context);
          const priorIntent = await api.memo("mybuddy.effect-intent", context);
          const fileCall = originalCall.name === "pstack_decision_append" ? originalCall : call;
          let intent: EffectIntent | undefined = priorIntent !== undefined ? effectIntentSchema.parse(priorIntent)
            : isNativeFileMutation(originalCall.name) ? undefined : await prepareFileEffect(fileCall, taskRoot);
          const origin = originalCall.name === "mcp_call_tool" && typeof originalCall.arguments.server === "string" && typeof originalCall.arguments.tool === "string"
            ? { server: originalCall.arguments.server, tool: originalCall.arguments.tool } : undefined;
          const prepared = !intent && !isNativeFileMutation(originalCall.name) && options.effectRecovery
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
        const originalCall = call;
        const container = call.name === "codemode";
        try { call = policyCall(call); }
        catch { /* Pi retains the invalid envelope result under its original tool identity. */ }
        const interrupted = result.diagnostics?.find(item =>
          ["interrupted", "aborted", "abandoned", "restart_limit"].includes(item.code ?? "")
          || isNativeShell(originalCall.name) && item.code === "tool_error"
            && (item.message === BASH_INACTIVITY_MESSAGE || /^Command timed out after [\d.e+-]+ seconds$/iu.test(item.message)));
        const execution = await identity(api, context, call);
        const attempt = options.attempts.findDurable(execution, call.id);
        const boundary = { ...execution, conversationId: api.conversationId, toolTaskId: api.taskId,
          callId: call.id, toolName: originalCall.name, ...(attempt ? { attemptId: attempt.id } : {}) };
        const savedReceipt = await api.memo(receiptMemo, context);
        const checkpoint = savedReceipt === undefined
          ? await observeToolReceipt(call, originalCall, result, api, context, attempt, boundary, interrupted, options)
          : receiptCheckpointSchema.parse(savedReceipt);
        const receipt = checkpoint.receipt;
        if (receipt.taskId !== boundary.taskId || receipt.conversationId !== boundary.conversationId ||
          receipt.toolTaskId !== boundary.toolTaskId || receipt.callId !== boundary.callId || receipt.toolName !== boundary.toolName ||
          receipt.executionId !== boundary.executionId || receipt.assistantMessageId !== boundary.assistantMessageId ||
          receipt.attemptId !== boundary.attemptId) throw new Error("Durable execution receipt identity mismatch");
        if (attempt) {
          options.attempts.settleDurable({ ...attempt, nativeReceipt: receipt, status: receipt.status, phase: "finished", finishedAt: receipt.checkedAt,
            transportStatus: receipt.transport === "returned" ? "succeeded" : "failed", observedExitCode: receipt.exitCode,
            causeCode: receipt.causeCode, recovery: receipt.status === "inconclusive" ? "requires-user-action" : undefined,
            verifierId: receipt.verifierId, verifierVersion: receipt.verifierVersion,
            verification: { ...execution, attemptId: attempt.id, verifierId: receipt.verifierId, verifierVersion: receipt.verifierVersion,
              target: attempt.target, ...checkpoint.verification, status: receipt.status, checkedAt: receipt.checkedAt,
              causeCode: receipt.causeCode },
          });
          if (receipt.status !== "inconclusive") options.failures.resolveMatching(options.taskId, { target: attempt.target, causeCodes: ["application-restarted", "durable-tool-interrupted", "effect-unverified"] });
        }
        if (!container) options.settleWorkAction?.(receipt);
        if (checkpoint.effectStatus === "inconclusive" && attempt)
          options.failures.recordIfAbsent({ ...execution, causeCode: "effect-unverified", phase: "verify", recovery: "requires-user-action", sideEffects: "unknown",
            target: attempt.target, message: "工具结果尚未通过内容或业务回执核验", nextAction: "检查核验证据和实际外部状态，确认前不要重复提交原操作。" });
        if (interrupted && receipt.transport === "interrupted" && !checkpoint.effectStatus) {
          options.interactions.cancelExecution(execution.executionId, "当前工具执行已结束");
          if (receipt.settlement === "unknown" && attempt) options.failures.recordIfAbsent({ ...execution,
            causeCode: "durable-tool-interrupted", phase: "recover", recovery: "requires-user-action", sideEffects: "unknown",
            target: attempt.target, message: `${call.name} 已中断，外部操作结果尚未确认：${interrupted.message}`,
            nextAction: "先回读文件、业务回执或外部状态。确认结果前不要重复提交同一副作用操作。" });
        }
        return projectToolReceipt(result, checkpoint, interrupted !== undefined);
      },
    },
  };
}

async function observeToolReceipt(call: ToolHookCall, originalCall: ToolHookCall, result: ToolExecutionResult, api: HookApi, context: Context,
  attempt: ReturnType<ExecutionAttemptRepository["findDurable"]>,
  boundary: Pick<NativeExecutionReceipt, "taskId" | "conversationId" | "toolTaskId" | "callId" | "toolName" | "executionId" | "assistantMessageId" | "attemptId">,
  interrupted: NonNullable<ToolExecutionResult["diagnostics"]>[number] | undefined, options: DurableToolPolicyOptions) {
  const mcp = mcpReadTools.has(call.name) ? null : classifyMcpToolCall(call.name, call.arguments, options.providerIds);
  const mayWrite = Boolean(attempt) || (call.name !== "codemode" && !workShellRead(call.name, call.arguments)
    && (mcp?.sideEffect ?? (isSideEffectTool(call.name, call.arguments) || isDangerousTool(call.name, call.arguments))));
  const proof = await api.memo(TOOL_NOT_STARTED_MEMO, context);
  const notStarted = isNativeNotStarted(api.taskId, String(api.conversationId)) || proof !== null && typeof proof === "object" && !Array.isArray(proof)
    && proof.toolName === call.name && proof.callId === call.id && proof.taskId === api.taskId
    && proof.conversationId === api.conversationId && proof.phase === "validation";
  // A blocked call cannot be reconciled by a file or receipt lookup.
  const nativeFile = isNativeFileMutation(originalCall.name);
  let evidence: EffectEvidence | undefined;
  if (attempt && !notStarted && nativeFile) {
    evidence = await api.memo<EffectEvidence>(NATIVE_FILE_EVIDENCE_MEMO, context);
  }
  const savedIntent = attempt && !notStarted && !evidence
    ? (nativeFile ? await api.memo(NATIVE_FILE_INTENT_MEMO, context) : undefined) ?? await api.memo("mybuddy.effect-intent", context) : undefined;
  if (savedIntent !== undefined) {
    const intent = readEffectIntent(savedIntent, originalCall);
    if (intent.kind === "file") evidence = await verifyFileEffect(intent, context.abortSignal);
    else if (options.effectRecovery && options.toolAllowed?.(durableMcpToolName(intent.server, intent.contract.receiptTool)) !== false) evidence = await options.effectRecovery.verify(intent, context);
    else evidence = { status: "inconclusive", verifierId: "durable-business-receipt",
      canonicalTarget: `${intent.server}/${intent.tool}/${intent.operationId}`,
      expected: { operationId: intent.operationId, completed: intent.contract.completedValues },
      observed: { reason: "receipt-verifier-unavailable-or-not-authorized" }, checkedAt: Date.now() };
  }
  const reconciled = evidence?.status === "passed";
  const confirmedFailure = evidence?.status === "failed";
  // A completed error is a normal tool result, not a lost execution. In
  // particular, native shell exit_code covers every command without parsing
  // shell text. A nonzero exit does NOT prove that no partial write occurred.
  // Throws/timeouts and interrupted tasks retain uncertainty, but Work stores
  // that fact as a diagnostic rather than locking unrelated work.
  const threw = result.diagnostics?.some(item => item.code === "tool_error") === true;
  const completedResponse = !interrupted && !threw;
  // The browser bridge can return a normal, structured error after dispatch.
  // Receiving that response gives no evidence about the external effect.
  const browserOutcome = call.name === "browser_exec" && result.isError
    ? unconfirmedBrowserResult.safeParse(result.structuredOutput).data?.outcome : undefined;
  const desktopOutcome = call.name === "ui_exec" || call.name === "computer_exec"
    ? readDesktopOperationOutcome(result.details) : undefined;
  const exitCode = result.structuredOutput && typeof result.structuredOutput === "object"
    && !Array.isArray(result.structuredOutput) && typeof result.structuredOutput.exitCode === "number"
    && Number.isSafeInteger(result.structuredOutput.exitCode) ? result.structuredOutput.exitCode : undefined;
  const unconfirmedDelivery = Boolean(browserOutcome) || desktopOutcome?.sideEffects === "unknown";
  const status = notStarted ? "failed" : evidence?.status ?? (!completedResponse || browserOutcome ? "inconclusive" : desktopOutcome?.status ?? (result.isError ? "failed" : "passed"));
  const settlement = notStarted ? "released" : reconciled || confirmedFailure || (!evidence && completedResponse && !unconfirmedDelivery) ? "consumed" : mayWrite ? "unknown" : "released";
  const causeCode = reconciled ? undefined : confirmedFailure ? "effect-receipt-failed" : evidence ? "effect-unverified"
    : browserOutcome ? "browser-effect-unknown" : interrupted?.code ?? desktopOutcome?.causeCode ??
      (notStarted ? result.diagnostics?.find(item => item.severity === "error" && item.code)?.code : threw ? "tool_error" : undefined);
  const checkedAt = evidence?.checkedAt ?? Date.now();
  const rawDetails = result.details !== null && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {};
  const fileReadAttempt = originalCall.name === "read" && !notStarted
    ? nativeFileReadAttemptSchema.safeParse(rawDetails[NATIVE_FILE_READ_ATTEMPT]).data : undefined;
  const openedPath = fileReadAttempt && !fileReadAttempt.openFailure ? fileReadAttempt.target : undefined;
  const [material] = status === "passed" && openedPath !== undefined
    ? collectRuntimeMaterialEvidence({ toolName: "read", toolCallId: call.id, isError: false,
      args: { ...call.arguments, path: openedPath }, result: { content: result.output, details: rawDetails } }, checkedAt) : [];
  const fileRead = material && typeof openedPath === "string" ? { target: openedPath, outputHash: material.outputHash,
    returnedChars: material.returnedChars, images: material.images, partial: material.partial,
    ...(material.offset !== undefined && { offset: material.offset }), ...(material.limit !== undefined && { limit: material.limit }) } : undefined;
  const admittedTarget = nativeFile ? await api.memo<FileMutationTarget>(FILE_MUTATION_TARGET_MEMO, context) : undefined;
  const changedPath = evidence?.verifierId === "durable-file-content" ? evidence.canonicalTarget : admittedTarget?.path;
  const checkedRange = evidence?.verifierId === "durable-file-content" && reconciled && typeof evidence.observed.sha256 === "string"
    && typeof evidence.observed.bytes === "number" ? { sha256: evidence.observed.sha256, bytes: evidence.observed.bytes,
      ...(typeof evidence.expected.offset === "number" && { offset: evidence.expected.offset }) } : undefined;
  const receipt: NativeExecutionReceipt = { ...boundary, version: 1, status,
    transport: notStarted ? "not_started" : completedResponse ? "returned" : "interrupted", settlement,
    verifierId: evidence?.verifierId ?? "durable-tool-result", verifierVersion: 1, checkedAt,
    ...(exitCode === undefined ? {} : { exitCode }), ...(causeCode === undefined ? {} : { causeCode }),
    ...(fileReadAttempt && { fileReadAttempt }), ...(fileRead && { fileRead }),
    ...(changedPath && { fileChange: { target: changedPath, ...(checkedRange && { checkedRange }) } }),
  };
  const verification = { canonicalTarget: evidence?.canonicalTarget ?? attempt?.target ?? `durable-tool:${api.conversationId}:${api.taskId}`,
    expected: evidence?.expected ?? { successfulToolResponse: true }, observed: evidence?.observed ?? { isError: result.isError === true,
      diagnosticCodes: (result.diagnostics ?? []).map(item => item.code ?? ""),
      ...(exitCode === undefined ? {} : { exitCode }), ...(browserOutcome ? { outcome: browserOutcome } : {}),
      ...(desktopOutcome ? { desktopOutcome } : {}), completedResponse, notStarted } };
  return receiptCheckpointSchema.parse(await api.memo(receiptMemo, { receipt, verification,
    ...(evidence ? { effectStatus: evidence.status } : {}) }, context));
}

function projectToolReceipt(result: ToolExecutionResult, { receipt, effectStatus }: z.infer<typeof receiptCheckpointSchema>, interrupted: boolean): ToolExecutionResult {
  const details = result.details !== null && typeof result.details === "object" && !Array.isArray(result.details)
    ? result.details : result.details === undefined ? {} : { toolDetails: result.details };
  const note = effectStatus === "failed" ? "业务回执确认本次操作失败。"
    : effectStatus === "inconclusive" ? "核验未确认原操作完成；没有自动重发。"
    : interrupted && receipt.settlement === "unknown"
      ? "工具已中断，外部操作结果尚未确认。先回读已有文件或业务回执，并核对由命令启动的外部进程，再决定是否重试。"
    : receipt.status === "passed" && (interrupted || result.isError)
      ? effectStatus === "passed" ? "已通过回读确认原操作完成，未重复执行。" : "已恢复原工具的执行回执，未重复执行。"
      : undefined;
  const projectedDetails: JsonObject = { ...details, executionReceipt: receipt };
  delete projectedDetails[NATIVE_FILE_READ_ATTEMPT];
  if (effectStatus && note) projectedDetails.recovery = { verifierId: receipt.verifierId, checkedAt: receipt.checkedAt, status: effectStatus };
  return { ...result, isError: receipt.status !== "passed", details: projectedDetails,
    ...(note ? { output: [...(result.output ?? []), { type: "text", text: note }] } : {}) };
}
