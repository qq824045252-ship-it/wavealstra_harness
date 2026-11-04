import type { AgentUiPatch } from "../../../../../shared/agent-ipc";
import type { ChatMessage, MessageBlock } from "../../../types";
import { formatDuration } from "../format";

export function upsertTextBlock(
  blocks: MessageBlock[],
  type: "text" | "thinking",
  delta: string,
): MessageBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) {
    return [...blocks.slice(0, -1), { type, text: last.text + delta }];
  }
  return [...blocks, { type, text: delta }];
}

export function freezeFinalTextSegment(
  finalBlocks: MessageBlock[] | undefined,
): MessageBlock[] | undefined {
  if (!finalBlocks || finalBlocks.length === 0) return finalBlocks;
  const last = finalBlocks[finalBlocks.length - 1];
  // 已冻结（末尾已是空 text 段）或末尾非 text → 不重复冻结
  if (last.type === "text" && last.text.trim() !== "") {
    return [...finalBlocks, { type: "text", text: "" }];
  }
  return finalBlocks;
}

export function appendErrorBlock(
  finalBlocks: MessageBlock[] | undefined,
  error: string,
): MessageBlock[] {
  const blocks = finalBlocks ?? [];
  const errText = `错误：${error}`;
  const last = blocks[blocks.length - 1];
  if (last?.type === "text" && last.text.trim() === errText) return blocks;
  return [...blocks, { type: "text", text: errText }];
}

export function nonEmptyFinalTextBlocks(
  finalBlocks: MessageBlock[] | undefined,
): MessageBlock[] {
  if (!finalBlocks) return [];
  return finalBlocks.filter((b) => b.type !== "text" || b.text.trim() !== "");
}

export function applyPatchToMessage(
  msg: ChatMessage,
  patch: AgentUiPatch,
): ChatMessage {
  switch (patch.type) {
    case "generation_stats":
      return { ...msg, generationStats: patch.stats };
    case "assistant_message_start":
      return { ...msg, finalBlocks: freezeFinalTextSegment(msg.finalBlocks) };
    case "assistant_start":
      return {
        ...msg,
        streaming: true,
        pendingBehavior: undefined,
        executionId: patch.executionId ?? msg.executionId,
        modelName: patch.modelName ?? msg.modelName,
      };
    case "conversation_interaction_snapshot": {
      const interactions = msg.interactions ?? [];
      const exists = interactions.some(
        (item) => item.id === patch.interaction.id,
      );
      return {
        ...msg,
        executionId: patch.executionId,
        interactions: exists
          ? interactions.map((item) =>
              item.id === patch.interaction.id ? patch.interaction : item,
            )
          : [...interactions, patch.interaction],
      };
    }
    case "text_delta": {
      // 防御：空 delta 不制造空 text block
      if (!patch.delta) return msg;
      if (patch.final) {
        return {
          ...msg,
          finalBlocks: upsertTextBlock(
            msg.finalBlocks ?? [],
            "text",
            patch.delta,
          ),
        };
      }
      return {
        ...msg,
        blocks: upsertTextBlock(msg.blocks, "text", patch.delta),
      };
    }
    case "thinking_delta":
      return {
        ...msg,
        blocks: upsertTextBlock(msg.blocks, "thinking", patch.delta),
      };
    case "tool_start": {
      if (
        [
          "request_user_input",
          "conversation_goal_get",
          "conversation_goal_create",
          "conversation_goal_update",
          "conversation_goal_propose_complete",
        ].includes(patch.tool)
      )
        return msg;
      const exists = msg.blocks.some(
        (b) => b.type === "tool" && b.toolCall.id === patch.toolCallId,
      );
      if (exists) {
        return {
          ...msg,
          blocks: msg.blocks.map((b) =>
            b.type === "tool" && b.toolCall.id === patch.toolCallId
              ? {
                  ...b,
                  toolCall: {
                    ...b.toolCall,
                    parentToolCallId:
                      patch.parentToolCallId ?? b.toolCall.parentToolCallId,
                    status: patch.status,
                    summary: patch.summary,
                    detail: patch.detail ?? b.toolCall.detail,
                    dangerous: patch.dangerous ?? b.toolCall.dangerous,
                    approvalKind: patch.approvalKind ?? b.toolCall.approvalKind,
                    externalRunId:
                      patch.externalRunId ?? b.toolCall.externalRunId,
                    acpPermissionOptions:
                      patch.acpPermissionOptions ??
                      b.toolCall.acpPermissionOptions,
                    targetPath: patch.targetPath ?? b.toolCall.targetPath,
                    taskRoot: patch.taskRoot ?? b.toolCall.taskRoot,
                    canonicalDir: patch.canonicalDir ?? b.toolCall.canonicalDir,
                  },
                }
              : b,
          ),
        };
      }
      // P0 invariant：正文区永不因工具调用而清空/迁移。
      // 冻结当前 prose 段（后续 text_delta 开新段），正文保留在用户可见区；
      // ExecutionTimeline（blocks）只负责 thinking/tool/事件，不重复承载正文。
      return {
        ...msg,
        blocks: [
          ...msg.blocks,
          {
            type: "tool",
            toolCall: {
              id: patch.toolCallId,
              parentToolCallId: patch.parentToolCallId,
              tool: patch.tool,
              summary: patch.summary,
              detail: patch.detail,
              status: patch.status,
              dangerous: patch.dangerous,
              approvalKind: patch.approvalKind,
              externalRunId: patch.externalRunId,
              acpPermissionOptions: patch.acpPermissionOptions,
              targetPath: patch.targetPath,
              taskRoot: patch.taskRoot,
              canonicalDir: patch.canonicalDir,
            },
          },
        ],
        finalBlocks: freezeFinalTextSegment(msg.finalBlocks),
      };
    }
    case "tool_update":
      return {
        ...msg,
        blocks: msg.blocks.map((b) =>
          b.type === "tool" && b.toolCall.id === patch.toolCallId
            ? {
                ...b,
                toolCall: {
                  ...b.toolCall,
                  parentToolCallId:
                    patch.parentToolCallId ?? b.toolCall.parentToolCallId,
                  status: patch.status ?? b.toolCall.status,
                  output: patch.output ?? b.toolCall.output,
                  consult: patch.consult ?? b.toolCall.consult,
                  webSearch: patch.webSearch ?? b.toolCall.webSearch,
                  summary: patch.summary ?? b.toolCall.summary,
                },
              }
            : b,
        ),
      };
    case "assistant_end":
      return {
        ...msg,
        streaming: false,
        pendingBehavior: undefined,
        durationLabel: formatDuration(patch.durationMs) ?? msg.durationLabel,
        finalBlocks: patch.error
          ? appendErrorBlock(msg.finalBlocks, patch.error)
          : msg.finalBlocks,
      };
    default:
      return msg;
  }
}
