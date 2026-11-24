import { InboxDoc, ToolTask, type Cursor, type EntryId, type Harness, type HookApi, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { isDangerousTool, isSideEffectTool } from "../../../shared/pi-event-mapper";
import { DOTS_DESKTOP_PREVIEW } from "../../../shared/dots-settings";
import { classifyMcpToolCall } from "../../security/McpSideEffectPolicy";
import { workShellRead } from "../work/WorkShellRead";
import { durableMcpToolName } from "./DurableMcp";
import { STEER_ENTRY_KIND } from "./DurableSteerReceipts";
import { DurableInputDeferredError } from "./DurableToolInputScope";

const publicationTools = new Set(["gmail_send", "calendar_create", "calendar_update", "conversation_goal_propose_complete",
  "work_submit_deliverable", "work_submit_result", "work_close", "work_request_close", "work_confirm_close", "work_publish"]);
const browserReads = new Set(["status", "tabs", "read", "screenshot", "find", "inspect", "wait_for", "frames", "accessibility", "assert", "diagnostics"]);

function isUserInstruction(entry: { kind: string; data?: unknown }): boolean {
  if (entry.kind === "pi.user" || entry.kind === STEER_ENTRY_KIND) return true;
  if (entry.kind !== "mybuddy.user") return false;
  const data = entry.data;
  const input = data && typeof data === "object" && "mybuddyInput" in data ? data.mybuddyInput : undefined;
  return !input || typeof input !== "object" || !("goalContinuation" in input) || !input.goalContinuation;
}

/** A mixed tool batch cannot terminate through Pi's per-tool control. Place the waiting
 * user instruction at the same post-tools boundary so the old proposal cannot loop. */
export async function prioritizeInputAfterDeferredGoal(results: readonly EntryId[], api: HookApi, context: Context, commit: Harness["commit"]) {
  if (results.length < 2) return;
  for (const id of results) {
    const result = (await api.entry(id, context))?.model?.[0];
    if (result?.role !== "toolResult" || result.toolName !== "conversation_goal_propose_complete" ||
      (result.details as { goalDeferredForInput?: boolean } | undefined)?.goalDeferredForInput !== true) continue;
    await commit(async tx => {
      const inbox = await tx.doc(InboxDoc, api.conversationId);
      for (const item of inbox.items) {
        if (item.mode === "followUp" && (!item.entry || isUserInstruction(item.entry))) item.mode = "steer";
      }
    }, context);
    return;
  }
}

export function needsFreshUserInput(name: string, args: unknown): boolean {
  if (name === "mcp_call_tool" && args && typeof args === "object"
    && "server" in args && "tool" in args && typeof args.server === "string" && typeof args.tool === "string") {
    return needsFreshUserInput(durableMcpToolName(args.server, args.tool), "arguments" in args ? args.arguments : undefined);
  }
  const mcp = classifyMcpToolCall(name, args);
  if (mcp) return mcp.sideEffect;
  if (publicationTools.has(name)) return true;
  if (name === DOTS_DESKTOP_PREVIEW || name === "dots_action" && args && typeof args === "object" &&
    ("deferredId" in args || "action" in args && ["delegate", "follow_up", "defer", "steer"].includes(String(args.action)))) return true;
  if (name === "conversation_goal_update" && args && typeof args === "object" && "status" in args)
    return args.status === "cancelled" || args.status === "achieved";
  if (name === "browser_exec" && args && typeof args === "object" && "action" in args && typeof args.action === "string") {
    if (args.action === "fetch") {
      const request = "request" in args ? args.request : undefined;
      return !!request && typeof request === "object" && "method" in request && !["GET", "HEAD"].includes(String(request.method));
    }
    return !browserReads.has(args.action);
  }
  if (workShellRead(name, args)) return false;
  return ["bash", "powershell", "execute_code", "terminal_exec", "browser_exec", "computer_exec", "ui_exec", "automation_exec"]
    .includes(name) && (isDangerousTool(name, args) || isSideEffectTool(name, args));
}

/** Check the Pi inbox for this call and its native owners, including Code Mode's private conversation. */
export async function checkDurableInputFreshness(api: ToolExecutionApi, context: Context, admitting?: () => readonly string[]) {
  for (;;) {
    const pending = admitting?.() ?? [];
    const deferred = await api.commit(async tx => {
      let id = api.conversationId;
      let trigger: TaskId | undefined = api.taskId;
      for (;;) {
        const inbox = await tx.doc(InboxDoc, id);
        if (inbox.items.some(item => item.mode !== "write" && (!item.entry || isUserInstruction(item.entry)))) return true;
        // The owner's model call has an exact assistant entry. This also detects
        // a steer already placed by the parent while a detached child was running.
        while (trigger !== undefined) {
          const task = await tx.task(trigger);
          if (!task || task.conversationId !== id) break;
          const call = task.input;
          if (task.kind === ToolTask.definition.name && call && typeof call === "object" && !Array.isArray(call)
            && call.kind === "model" && typeof call.assistant === "number") {
            // Pi cannot place a newer input until its live tool batch settles.
            // Only a detached descendant can still dispatch after its owner's tool ends.
            if (task.state.status !== "terminal") break;
            let cursor: Cursor | undefined;
            do {
              const entries = await tx.scanEntries({ conversationId: id, minEntryId: (call.assistant + 1) as EntryId }, 64, cursor);
              if (entries.items.some(isUserInstruction)) return true;
              cursor = entries.next;
            } while (cursor);
            break;
          }
          trigger = task.owner;
        }
        const owner = (await tx.conversation(id))?.owner;
        if (!owner) {
          for (const requestId of pending) if (!await tx.submissionByRequest(id, requestId)) return true;
          return false;
        }
        id = owner.conversationId;
        trigger = owner.taskId;
      }
    }, context);
    const current = admitting?.() ?? [];
    if (current.some(id => !pending.includes(id))) continue;
    if (deferred) throw new DurableInputDeferredError("有较新的用户输入等待处理，本次操作尚未开始。请结束当前回复，让新输入进入模型后，再根据最新指示决定是否执行。");
    return;
  }
}
