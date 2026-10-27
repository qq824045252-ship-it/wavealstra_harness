import { searchReportFromDetails, searchReportSummary } from "./web-search";
import { consultReportFromDetails, consultSummary } from "./multi-model-consult";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentUiPatch } from "./agent-ipc";
import { MUTATING_BUILTIN_TOOLS } from "./native-tools";

export interface MapperContext {
  taskId: string;
  messageId: string;
  modelName?: string;
  startedAt: number;
  /** 当前 provider assistant message 已经发给 UI 的 thinking 文本。message_start 时重置。 */
  emittedThinking?: string;
  /** UI projection only: Pi owns all execution and retry decisions. */
  activeReplyId?: string;
  settled?: boolean;
  terminalError?: string;
}

function assistantThinkingSnapshot(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let thinking = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: unknown; thinking?: unknown };
    if (block.type === "thinking" && typeof block.thinking === "string") thinking += block.thinking;
  }
  return thinking;
}

/**
 * 仅在 thinking_end/message_end 用 Pi snapshot 补齐未发送的后缀。
 * 实时输出必须来自原生 delta；完成时补齐不能算流式修复。
 */
function reconcileThinkingSnapshot(
  snapshot: string,
  ctx: MapperContext,
  taskId: string,
  messageId: string,
): AgentUiPatch[] {
  if (!snapshot) return [];
  const emitted = ctx.emittedThinking ?? "";
  if (snapshot === emitted) return [];
  if (!snapshot.startsWith(emitted)) {
    // 追加型 UI patch 无法安全纠正 provider 对既有 reasoning 的回写；宁可保留已流式内容，
    // session/history 仍以 Pi 最终消息为准，避免在 UI 中把整段 thinking 重复一次。
    return [];
  }
  const delta = snapshot.slice(emitted.length);
  ctx.emittedThinking = snapshot;
  return delta ? [{ type: "thinking_delta", taskId, messageId, delta }] : [];
}

export const COMPUTER_EXEC_READONLY_ACTIONS = new Set([
  "attach_app",
  "status",
  "active_window",
  "list_windows",
  "inspect_window",
  "wait_for_window",
  "screenshot",
  "ocr_window",
  "inspect_controls",
  "find_control",
]);

export function isComputerExecReadonly(input: unknown): boolean {
  const value = (input ?? {}) as { action?: unknown; ensure_foreground?: unknown; background?: unknown; actions?: unknown };
  if (Array.isArray(value.actions) && value.actions.length > 0) return false;
  const action = String(value.action ?? "");
  if (action === "screenshot_window") return value.ensure_foreground === false || value.background === true;
  return COMPUTER_EXEC_READONLY_ACTIONS.has(action);
}

function summarizeToolInput(tool: string, input: unknown): { summary: string; detail?: string } {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "multi_model_consult") return { summary: "多模型会诊", detail: typeof obj.task === "string" ? obj.task : undefined };
  if ((tool === "bash" || tool === "terminal") && typeof obj.command === "string") {
    return { summary: obj.command, detail: obj.command };
  }
  if (tool === "execute_code" && typeof obj.language === "string") {
    // script 模式没有 code，只显示语言会让审批卡片空白——看不出到底要跑哪个脚本
    if (typeof obj.script === "string") {
      const args = Array.isArray(obj.args) ? obj.args.map((arg) => String(arg)).join(" ") : "";
      return { summary: `${obj.language}: ${obj.script}${args ? ` ${args}` : ""}`.slice(0, 120), detail: JSON.stringify(obj, null, 2) };
    }
    const code = typeof obj.code === "string" ? obj.code : "";
    return { summary: `${obj.language}: ${code.slice(0, 100)}`, detail: code };
  }
  if ((tool === "image_generate" || tool === "video_generate") && typeof obj.prompt === "string") {
    return { summary: obj.prompt.slice(0, 120), detail: JSON.stringify(obj, null, 2) };
  }
  if (tool === "text_to_speech" && typeof obj.text === "string") {
    return { summary: obj.text.slice(0, 120), detail: JSON.stringify(obj, null, 2) };
  }
  if (tool === "computer_exec" && Array.isArray(obj.actions) && obj.actions.length > 0) {
    return { summary: `batch: ${obj.actions.length} 步`, detail: JSON.stringify(obj, null, 2) };
  }
  if ((tool === "browser_exec" || tool === "ui_exec" || tool === "computer_exec" || tool === "runtime_probe") && typeof obj.action === "string") {
    const target = typeof obj.url === "string"
      ? obj.url
      : typeof obj.selector === "string"
        ? obj.selector
        : typeof obj.window_title === "string"
          ? obj.window_title
          : typeof obj.text === "string"
            ? obj.text.slice(0, 60)
            : "";
    return { summary: `${obj.action}${target ? `: ${target}` : ""}`.slice(0, 120), detail: JSON.stringify(obj, null, 2) };
  }
  if ((tool === "write" || tool === "edit" || tool === "read") && typeof obj.path === "string") {
    return { summary: obj.path, detail: JSON.stringify(obj, null, 2) };
  }
  try {
    const raw = JSON.stringify(obj);
    return { summary: raw.slice(0, 120), detail: raw };
  } catch {
    return { summary: tool };
  }
}

function isDangerousTool(tool: string, input: unknown): boolean {
  if (tool === "execute_code") return true;
  if (tool === "browser_exec") {
    const action = String((input as { action?: string })?.action ?? "");
    return action === "click" || action === "fill" || action === "press";
  }
  if (tool === "ui_exec") {
    const action = String((input as { action?: string })?.action ?? "");
    return action === "click" || action === "fill" || action === "press" || action === "scroll";
  }
  if (tool === "computer_exec") {
    return !isComputerExecReadonly(input);
  }
  return false;
}

function isSideEffectTool(tool: string, input: unknown): boolean {
  if ((MUTATING_BUILTIN_TOOLS as readonly string[]).includes(tool)) {
    return true;
  }
  if (tool === "browser_exec") {
    const action = String((input as { action?: string })?.action ?? "");
    return action !== "status" && action !== "read" && action !== "screenshot";
  }
  if (tool === "ui_exec") {
    const action = String((input as { action?: string })?.action ?? "");
    return ["click", "fill", "press", "scroll"].includes(action);
  }
  if (tool === "computer_exec") {
    return !isComputerExecReadonly(input);
  }
  return false;
}

/**
 * 将单条 pi AgentSessionEvent 映射为 0..n 条 UI 补丁。
 * 审批态由 AgentService 在 tool_call 扩展里单独发 tool_start(pending_approval)。
 */
export function mapPiEventToPatches(
  event: AgentSessionEvent,
  ctx: MapperContext,
): AgentUiPatch[] {
  const { taskId, messageId } = ctx;

  switch (event.type) {
    case "agent_start":
      if (ctx.activeReplyId === messageId && !ctx.settled) return [];
      ctx.activeReplyId = messageId;
      ctx.settled = false;
      ctx.terminalError = undefined;
      ctx.emittedThinking = "";
      return [
        {
          type: "assistant_start",
          taskId,
          messageId,
          modelName: ctx.modelName,
        },
      ];

    case "message_start":
      // One UI reply can contain several provider messages. Preserve this boundary:
      // a retry must not continue an interrupted Markdown fence from the last attempt.
      if (event.message.role === "assistant") {
        ctx.emittedThinking = "";
        ctx.terminalError = undefined;
        return [{ type: "assistant_message_start", taskId, messageId }];
      }
      return [];

    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (!ame) return [];
      // Native Pi deltas are the live path. Do not inspect growing snapshots here:
      // a partial can lag a delta (dropping it) or already contain later events.
      if (ame.type === "text_delta" && typeof ame.delta === "string") {
        return ame.delta ? [{ type: "text_delta", taskId, messageId, delta: ame.delta, final: true }] : [];
      }
      if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
        if (!ame.delta) return [];
        ctx.emittedThinking = (ctx.emittedThinking ?? "") + ame.delta;
        return [{ type: "thinking_delta", taskId, messageId, delta: ame.delta }];
      }
      // Boundary-only recovery for providers that publish text only at block end.
      // This is a final consistency fallback, never a replacement for streaming.
      return ame.type === "thinking_end"
        ? reconcileThinkingSnapshot(assistantThinkingSnapshot(event.message), ctx, taskId, messageId)
        : [];
    }

    case "message_end":
      return event.message.role === "assistant"
        ? reconcileThinkingSnapshot(assistantThinkingSnapshot(event.message), ctx, taskId, messageId)
        : [];

    case "tool_execution_start": {
      const tool = event.toolName;
      const toolCallId = event.toolCallId;
      const { summary, detail } = summarizeToolInput(tool, event.args);
      return [
        {
          type: "tool_start",
          taskId,
          messageId,
          toolCallId,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          tool,
          summary,
          detail,
          dangerous: isDangerousTool(tool, event.args),
          status: "running",
        },
      ];
    }

    case "tool_execution_update": {
      const partial = event.partialResult;
      const webSearch = searchReportFromDetails((partial as { details?: unknown })?.details);
      if (webSearch) return [{ type: "tool_update", taskId, messageId, toolCallId: event.toolCallId, webSearch, summary: searchReportSummary(webSearch) }];
      if (event.toolName === "multi_model_consult") {
        const consult = consultReportFromDetails((partial as { details?: unknown })?.details);
        if (consult) return [{ type: "tool_update", taskId, messageId, toolCallId: event.toolCallId, consult, summary: consultSummary(consult) }];
      }
      const chunk =
        typeof partial === "string"
          ? partial
          : partial != null
            ? JSON.stringify(partial).slice(0, 2000)
            : undefined;
      if (!chunk) return [];
      return [
        {
          type: "tool_update",
          taskId,
          messageId,
          toolCallId: event.toolCallId,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          output: chunk,
        },
      ];
    }

    case "tool_execution_end": {
      const isError = Boolean(event.isError);
      const webSearch = searchReportFromDetails((event.result as { details?: unknown })?.details);
      const consult = event.toolName === "multi_model_consult" ? consultReportFromDetails((event.result as { details?: unknown })?.details) : undefined;
      let output: string | undefined;
      try {
        const result = event.result;
        if (typeof result === "string") output = result;
        else if (result && typeof result === "object") {
          const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
          if (Array.isArray(content)) {
            output = content
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text)
              .join("\n");
          } else {
            output = JSON.stringify(result).slice(0, 4000);
          }
        }
      } catch {
        /* ignore */
      }
      return [
        {
          type: "tool_update",
          taskId,
          messageId,
          toolCallId: event.toolCallId,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          status: isError ? "error" : "success",
          output,
          ...(consult ? { consult, summary: consultSummary(consult) } : {}),
          ...(webSearch ? { webSearch, summary: searchReportSummary(webSearch) } : {}),
        },
      ];
    }

    case "agent_end": {
      // This is a low-level boundary: Pi may retry, compact, or drain queued input.
      // Remember the native outcome but never tell the UI that the run has settled.
      const last = [...event.messages].reverse().find((message) => message.role === "assistant");
      if (last?.role === "assistant") {
        ctx.terminalError = last.stopReason === "error" ? last.errorMessage || "模型连接或生成失败，请重试。" : undefined;
      }
      return [];
    }

    case "agent_settled": {
      if (ctx.activeReplyId !== messageId) { ctx.activeReplyId = messageId; ctx.settled = false; }
      if (ctx.settled) return [];
      ctx.settled = true;
      return [{ type: "assistant_end", taskId, messageId,
        durationMs: Date.now() - ctx.startedAt, error: ctx.terminalError }];
    }

    default:
      return [];
  }
}

export { summarizeToolInput, isDangerousTool, isSideEffectTool };
