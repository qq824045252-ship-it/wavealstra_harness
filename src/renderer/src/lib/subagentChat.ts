/**
 * subagentChat.ts — 把子会话的消息流映射成主聊天同一套 ChatMessage。
 *
 * 两个真实来源（都来自既有事实，不新增 IPC）：
 * - 运行中：`subagent:transcript` 的 message_end 条目（活实例）；
 * - 已完成：subagent 工具调用 details.results[].messages（派发结束后唯一残留）。
 *
 * 复用 `historyMessageToChatMessage` + `summarizeToolInput`，所以工具卡、思考块、
 * 折叠时间线与主聊天完全同源——「共用通用聊天界面」指的是真的共用，而不是长得像。
 */
import type { ChatMessage, MessageBlock, ToolCall } from "@/types";
import type { ChatMessageDto, ChatToolCallDto } from "@shared/agent-ipc";
import { summarizeToolInput } from "@shared/pi-event-mapper";
import { historyMessageToChatMessage } from "@/store/app/messages/historyMapper";
import type { ChildMessage, SubagentResultRun } from "@/lib/subagentDetails";
import { childMessageText, parseSubagentDetails } from "@/lib/subagentDetails";

interface ToolOutcome {
  text: string;
  isError: boolean;
}

function parts(message: ChildMessage): Array<Record<string, unknown>> {
  return Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** toolResult 消息 → toolCallId 索引（工具卡要拿它填 output/status）。 */
function collectToolOutcomes(messages: ChildMessage[]): Map<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
    if (!id) continue;
    outcomes.set(id, { text: childMessageText(message), isError: message.isError === true });
  }
  return outcomes;
}

function toolBlock(part: Record<string, unknown>, index: number, prefix: string, outcomes: Map<string, ToolOutcome>): ChatToolCallDto {
  const toolName = textOf(part.name) || "tool";
  const id = textOf(part.id) || `${prefix}:tool:${index}`;
  const summarized = summarizeToolInput(toolName, part.arguments);
  const outcome = outcomes.get(id);
  return {
    id,
    tool: toolName,
    summary: summarized.summary,
    ...(summarized.detail === undefined ? {} : { detail: summarized.detail }),
    status: outcome ? (outcome.isError ? "error" : "success") : "running",
    ...(outcome === undefined ? {} : { output: outcome.text }),
  };
}

function assistantDto(message: ChildMessage, index: number, prefix: string, outcomes: Map<string, ToolOutcome>): ChatMessageDto {
  const id = `${prefix}:a${index}`;
  const content = parts(message);
  const tools = content
    .map((part, partIndex) => ({ part, partIndex }))
    .filter(({ part }) => part.type === "toolCall")
    .map(({ part, partIndex }) => toolBlock(part, partIndex, prefix, outcomes));
  return {
    id,
    projectionVersion: 1,
    role: "assistant",
    text: childMessageText(message) + (message.errorMessage ? `\n${message.errorMessage}` : ""),
    thinking: content.filter((part) => part.type === "thinking").map((part) => textOf(part.thinking) || textOf(part.text)).join(""),
    tools,
    modelName: typeof message.model === "string" ? message.model : undefined,
    createdAt: typeof message.timestamp === "number" ? message.timestamp : 0,
  } as ChatMessageDto;
}

function childMessageToDto(message: ChildMessage, index: number, prefix: string, outcomes: Map<string, ToolOutcome>): ChatMessageDto | null {
  const role = message.role;
  if (role === "user") {
    return {
      id: `${prefix}:u${index}`,
      projectionVersion: 1,
      role: "user",
      text: childMessageText(message),
      createdAt: typeof message.timestamp === "number" ? message.timestamp : 0,
    } as ChatMessageDto;
  }
  if (role === "assistant") return assistantDto(message, index, prefix, outcomes);
  // toolResult 已经并进对应工具卡，不再单独成行
  return null;
}

/**
 * 子会话消息 → 主聊天同一套 ChatMessage。
 * `task` 用于在没有 user 消息时补上「这次让它做什么」（results[].messages 被裁剪时仍能看到任务）。
 */
export function childMessagesToChatMessages(
  messages: ChildMessage[],
  opts: { prefix: string; task?: string; durationLabel?: string },
): ChatMessage[] {
  const outcomes = collectToolOutcomes(messages);
  const rows: ChatMessage[] = [];
  messages.forEach((message, index) => {
    const dto = childMessageToDto(message, index, opts.prefix, outcomes);
    if (!dto) return;
    const row = historyMessageToChatMessage(dto);
    // 主聊天里助手的正文走 finalBlocks，blocks 只放过程（思考/工具），与 durable 行一致
    rows.push(
      row.role === "assistant"
        ? { ...row, blocks: row.blocks.filter((block) => block.type !== "text") }
        : row,
    );
  });
  const hasUser = rows.some((row) => row.role === "user");
  if (!hasUser && (opts.task ?? "").trim()) {
    rows.unshift({
      id: `${opts.prefix}:task`,
      role: "user",
      blocks: [{ type: "text", text: opts.task!.trim() }],
      createdAt: 0,
    });
  }
  const lastAssistant = [...rows].reverse().find((row) => row.role === "assistant");
  if (lastAssistant && opts.durationLabel) lastAssistant.durationLabel = opts.durationLabel;
  return rows;
}

/** transcript 条目 → 子会话消息（只取 message_end；其余事件是状态，不是对话）。 */
export function transcriptEntriesToChildMessages(entries: ReadonlyArray<{ type?: string; message?: unknown }> | undefined): ChildMessage[] {
  const out: ChildMessage[] = [];
  for (const entry of entries ?? []) {
    if (entry?.type !== "message_end") continue;
    const message = entry.message;
    if (message && typeof message === "object") out.push(message as ChildMessage);
  }
  return out;
}

/**
 * 在任务时间线里找该子会话的结构化结果（已完成子代理的唯一数据源）。
 * 同一 id 可能多次出现（复用运行中）：取最后一次。
 */
export function findSubagentResultRun(messages: ChatMessage[], subagentId: string): SubagentResultRun | null {
  let found: SubagentResultRun | null = null;
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "tool" || block.toolCall.tool !== "subagent") continue;
      const run = parseSubagentDetails(block.toolCall.detail)?.results.find((item) => item.subagentId === subagentId);
      if (run) found = run;
    }
  }
  return found;
}

/** 该子会话被赋予的任务正文（优先结构化结果，其次运行中 DTO 的 lastTask）。 */
export function subagentTaskText(run: SubagentResultRun | null, fallback?: string): string | undefined {
  const task = (run?.task ?? "").trim();
  return task || (fallback ?? "").trim() || undefined;
}
