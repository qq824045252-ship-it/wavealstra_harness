import { resolve } from "node:path";
import { z } from "zod";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { isDangerousTool, isSideEffectTool } from "../../../shared/pi-event-mapper";
import { WEB_ACCESS_TOOL_NAMES } from "../../../shared/native-tools";
import { OFFICE_USE_TOOLS } from "../../../shared/office-use";
import { CAD_USE_TOOLS } from "../../../shared/cadcraft";
import { DRAWIO_USE_TOOLS } from "../../../shared/drawio-use";
import { fileResourceAddress, resourcePathContains } from "../../platform/resource-identity";
import { classifyMcpToolCall } from "../../security/McpSideEffectPolicy";
import { workShellRead } from "../work/WorkShellRead";
import { durableMcpToolName } from "./DurableMcp";
import { isDurableContextToolName } from "./context/DurableContextTools";
import { TOOL_NOT_STARTED_MEMO } from "./DurableToolOutcome";
import { checkDurableInputFreshness, needsFreshUserInput } from "./DurableInputFreshness";
import { DurableInputDeferredError, withToolInputFreshness } from "./DurableToolInputScope";
import { isNativeReviewWrite, nativeReviewPath, withCodeReviewWrite, type DurableCodeReview } from "./DurableCodeReview";

type Access = { kind: "file"; mode: "read" | "write"; path: string; entity: string | null } | { kind: "unknown"; mode: "read" | "write" };
type Request = { inspect: () => Access[]; accesses: Access[]; grant: (release: () => void) => void;
  reject: (error: unknown) => void; detach: () => void };
const active = new Set<Request>();
const pending: Request[] = [];
const argsSchema = z.record(z.string(), z.unknown());
const mcpEnvelope = z.object({ server: z.string(), tool: z.string(), arguments: argsSchema });
// Nested calls acquire their own resource leases. Holding an outer unknown-write lease would deadlock them.
const containers = new Set(["codemode", "subagent", "subagent_list", "subagent_steer", "multi_model_consult", "request_user_input", "pstack_workflow", "pstack_delegate", "pstack_orchestrate"]);
const fileReads = new Set(["read", "ls", "find", "grep", "glob"]);
const independentReads = new Set<string>([...WEB_ACCESS_TOOL_NAMES,
  DRAWIO_USE_TOOLS.shapes, DRAWIO_USE_TOOLS.reference,
  "pstack_watch_pr", "pstack_worktrees",
  "tool_search", "mcp_list_tools", "mcp_list_resources", "mcp_read_resource", "mcp_status"]);
const resourceReads = new Set(["library_list", "library_search", "library_deep_search", "library_read", "memory_search", "memory_get", "memory_history",
  "answer_rule_list", "answer_rule_test", "answer_rule_distill", "workspace_notes_read", "project_notes_read", "project_knowledge_search", "project_knowledge_read", "project_memory_list", "project_memory_get", "project_memory_search"]);
// Goal state is transactional; file access remains owned by the actual task tools.
const hostControls = new Set(["conversation_goal_get", "conversation_goal_create",
  "conversation_goal_update", "conversation_goal_propose_complete",
  OFFICE_USE_TOOLS.documentRead, OFFICE_USE_TOOLS.documentRender, OFFICE_USE_TOOLS.reviewStatus,
  OFFICE_USE_TOOLS.selectionRead, OFFICE_USE_TOOLS.selectionPropose, OFFICE_USE_TOOLS.editPropose, OFFICE_USE_TOOLS.nativeTools]);

const dotsTaskControls = new Set(["task", "steer", "pause", "stop"]);

function conflicts(left: Access[], right: Access[]): boolean {
  return left.some(a => right.some(b => (a.mode === "write" || b.mode === "write") && (a.kind === "unknown" || b.kind === "unknown"
    || a.entity !== null && a.entity === b.entity || resourcePathContains(a.path, b.path) || resourcePathContains(b.path, a.path))));
}

function drain(): void {
  const waiting: Request[] = [];
  for (const request of [...pending]) {
    try { request.accesses = request.inspect(); }
    catch (error) {
      pending.splice(pending.indexOf(request), 1); request.detach(); request.reject(error); continue;
    }
    if ([...active, ...waiting].some(other => conflicts(request.accesses, other.accesses))) {
      waiting.push(request); continue;
    }
    pending.splice(pending.indexOf(request), 1);
    request.detach(); active.add(request);
    let released = false;
    request.grant(() => {
      if (released) return;
      released = true; active.delete(request); drain();
    });
  }
}

function acquire(inspect: () => Access[], signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  return new Promise((grant, reject) => {
    const abort = () => {
      const index = pending.indexOf(request);
      if (index < 0) return;
      pending.splice(index, 1); request.detach(); reject(signal?.reason ?? new Error("工具等待已取消")); drain();
    };
    const request: Request = { inspect, accesses: [], grant, reject,
      detach: () => signal?.removeEventListener("abort", abort) };
    pending.push(request); signal?.addEventListener("abort", abort, { once: true }); drain();
  });
}

export async function withCodeReviewLease<T>(path: string, operation: () => T): Promise<T> {
  const release = await acquire(() => {
    try { return [{ kind: "file", mode: "write", ...fileResourceAddress(path) }]; }
    catch { return [{ kind: "file", mode: "write", path, entity: null }]; }
  });
  try { return operation(); } finally { release(); }
}

function inspectAccess(name: string, value: unknown, cwd: string): Access[] {
  const args = argsSchema.parse(value);
  if (name === "mcp_call_tool") {
    const envelope = mcpEnvelope.parse(args);
    return inspectAccess(durableMcpToolName(envelope.server, envelope.tool), envelope.arguments, cwd);
  }
  if (containers.has(name) || isDurableContextToolName(name) || hostControls.has(name)) return [];
  // These actions inspect or control the target runtime, whose tools retain their own resource leases.
  if (name === "dots_action" && typeof args.action === "string" && dotsTaskControls.has(args.action)) return [];
  const file = (path: string, mode: "read" | "write"): Access => {
    const address = fileResourceAddress(resolve(cwd, path));
    return { kind: "file", mode, path: address.path, entity: address.entity };
  };
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
  if (path && [CAD_USE_TOOLS.inspect, DRAWIO_USE_TOOLS.read, DRAWIO_USE_TOOLS.link].some(tool => name === tool)) return [file(path, "read")];
  if (path && [CAD_USE_TOOLS.create, CAD_USE_TOOLS.edit, CAD_USE_TOOLS.export,
    DRAWIO_USE_TOOLS.create, DRAWIO_USE_TOOLS.edit, DRAWIO_USE_TOOLS.layout, DRAWIO_USE_TOOLS.export].some(tool => name === tool)) {
    return [file(path, "write"), ...(typeof args.source === "string" ? [file(args.source, "read")] : [])];
  }
  if (fileReads.has(name)) return [file(path ?? ".", "read")];
  if (name === "write" || name === "edit" || name === "pstack_decision_append" || name === "pstack_eval_save" || name === OFFICE_USE_TOOLS.documentCreate) return path ? [file(path, "write")] : [{ kind: "unknown", mode: "write" }];
  const read = workShellRead(name, args);
  if (read) return [file(read.path, "read")];
  const mcp = classifyMcpToolCall(name, args);
  if (mcp?.decision.paths.length) return mcp.decision.paths.map(path => file(path, mcp.sideEffect ? "write" : "read"));
  if (mcp?.sideEffect || isSideEffectTool(name, args) || isDangerousTool(name, args)) return [{ kind: "unknown", mode: "write" }];
  if (mcp?.clearlyReadonly) return [{ kind: "unknown", mode: "read" }];
  if (independentReads.has(name)) return [];
  if (resourceReads.has(name)) return [{ kind: "unknown", mode: "read" }];
  // Unknown commands/providers may write outside cwd. A model-declared target is not evidence of isolation.
  return [{ kind: "unknown", mode: "write" }];
}

/** Wrap execution, not beforeTool: Pi's safe recovery re-enters execute without running beforeTool. */
export function withDurableToolCoordination(tool: ToolRegistration, fallbackCwd: string,
  beforeExecute?: (name: string, args: unknown, cwd: string) => void, admitting?: () => readonly string[],
  codeReview?: DurableCodeReview): ToolRegistration {
  if (containers.has(tool.name) || isDurableContextToolName(tool.name))
    return { ...tool, execute: (args, api, context) => withToolInputFreshness(undefined, async () => tool.execute(args, api, context)) };
  return { ...tool, execute: async (args, api, context) => {
    let release: (() => void) | undefined;
    let started = false;
    try {
      const cwd = (await api.agent(context)).cwd ?? fallbackCwd;
      const reviewPath = codeReview && isNativeReviewWrite(tool.name) ? await nativeReviewPath(api, context, args) : undefined;
      release = await acquire(() => inspectAccess(tool.name, reviewPath ? { path: reviewPath } : args, cwd), context.abortSignal);
      const check = needsFreshUserInput(tool.name, args) ? () => checkDurableInputFreshness(api, context, admitting) : undefined;
      if (check) await check();
      context.abortSignal?.throwIfAborted();
      beforeExecute?.(tool.name, args, cwd);
      started = true;
      const invoke = async () => codeReview
        ? withCodeReviewWrite(codeReview, tool.name, args, api, context, async observed => tool.execute(args, observed, context))
        : tool.execute(args, api, context);
      return await withToolInputFreshness(check, invoke);
    }
    catch (error) {
      if (!started || error instanceof DurableInputDeferredError) {
        const envelope = tool.name === "mcp_call_tool" ? mcpEnvelope.safeParse(args) : undefined;
        const toolName = envelope?.success ? durableMcpToolName(envelope.data.server, envelope.data.tool) : tool.name;
        await api.memo(TOOL_NOT_STARTED_MEMO, { toolName, callId: api.callId, taskId: api.taskId,
          conversationId: api.conversationId, phase: "validation" }, withoutAbortSignal(context));
      }
      throw error;
    }
    finally { release?.(); }
  } };
}
