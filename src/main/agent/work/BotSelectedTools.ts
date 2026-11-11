import { botExternalAgentTaskId, botMessageDisplayText, type BotAttachmentDto } from "../../../shared/bot-conversation";
import { defineTool, type ToolRegistration, type EntryRecord } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";
import type { ExternalAgentRuntime } from "../../external-agent/ExternalAgentRuntime";

export interface BotSelectedHostRequest { text: string; attachments?: BotAttachmentDto[] }
export interface BotSelectedToolOptions { consultRequested?: boolean; externalAgentId?: string; hostRequest?: BotSelectedHostRequest }
export function selectedBotTool(options?: BotSelectedToolOptions): string | undefined {
  if (options?.consultRequested && options.externalAgentId) throw new Error("多模型会诊与外部 Agent 不能同时选择");
  return options?.externalAgentId ? "delegate_selected_agent" : options?.consultRequested ? "multi_model_consult" : undefined;
}
export function assertSelectedBotToolExecuted(requiredTool: string | undefined, messages: Array<{ tools?: Array<{ tool: string; status: string }> }>): void {
  if (requiredTool && !messages.some(message => message.tools?.some(tool => tool.tool === requiredTool && tool.status === "success")))
    throw new Error(`本条请求未成功执行所选能力 ${requiredTool}，未将普通模型回答作为完成结果`);
}
/** Consume authoritative entries across every page; compaction/presentation windows are not request boundaries. */
export function selectedBotToolEvidence(requestId: string, requiredTool: string | undefined) {
  let current = false, executed = false;
  const calls = new Set<string>();
  return {
    observe(entry: Pick<EntryRecord, "kind" | "data" | "model">): void {
      if (entry.kind === "mybuddy.user") {
        const data = entry.data as { mybuddyInput?: { botRequestId?: string } } | undefined;
        current = data?.mybuddyInput?.botRequestId === requestId;
        executed = false;
        calls.clear();
      }
      if (!current || !requiredTool) return;
      for (const message of entry.model ?? []) {
        if (message.role === "assistant") for (const block of message.content) {
          if (block.type === "toolCall" && block.name === requiredTool) calls.add(block.id);
        }
        if (message.role === "toolResult" && message.toolName === requiredTool && calls.has(message.toolCallId) && !message.isError)
          executed = true;
      }
    },
    assert(): void {
      assertSelectedBotToolExecuted(requiredTool, executed ? [{ tools: [{ tool: requiredTool!, status: "success" }] }] : []);
    },
  };
}
/** Bound to the host selection, never an agent id supplied by the model. */
export function selectedExternalAgentTool(input: {
  hostRequest: BotSelectedHostRequest; requestIdentity: string; agentId: string; runtime: Pick<ExternalAgentRuntime, "listAgents" | "prompt" | "history" | "cancel">;
  createTask: (id: string, title: string) => void;
  onStatus?: (text: string) => void;
}): ToolRegistration {
  const available = () => {
    const agent = input.runtime.listAgents().find(item => item.id === input.agentId);
    if (!agent?.available || !agent.enabled) throw new Error(`所选外部 Agent ${input.agentId} 不可用或已停用`);
    return agent;
  };
  available();
  return defineTool({ name: "delegate_selected_agent", description: "本条消息已明确选择外部 Agent。必须将完整请求及必要上下文交给此工具，再根据实际结果回答。Agent 由宿主固定，不能替换。审批时请打开返回的任务。",
    parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 200000 }) }), replay: "unsafe",
    execute: async (_args, api, context) => {
      context.abortSignal?.throwIfAborted();
      const agent = available();
      // Stable native identity also prevents manually retried invocations duplicating ACP side effects.
      const taskId = botExternalAgentTaskId(input.requestIdentity);
      let history = input.runtime.history(taskId);
      let run = history.runs.at(-1);
      if (!run) {
        input.createTask(taskId, `Bot · ${agent.name} · ${botMessageDisplayText(input.hostRequest.text).slice(0, 60)}`);
        context.abortSignal?.throwIfAborted();
        const receipt = input.runtime.prompt({ taskId, agentId: agent.id, text: input.hostRequest.text,
          displayText: botMessageDisplayText(input.hostRequest.text), attachments: input.hostRequest.attachments,
          userMessageId: `${taskId}-user`, assistantMessageId: `${taskId}-assistant` });
        run = input.runtime.history(taskId).runs.find(item => item.runId === receipt.runId);
        if (!run) throw new Error("外部 Agent 执行回执缺失，请核对任务，不会自动重发");
      }
      if (run.agentId !== agent.id) throw new Error("持久外部 Agent 与本条消息选择不一致");
      const runId = run.runId;
      input.onStatus?.(`已交给 ${agent.name} 执行。需要审批时，请在任务列表打开“Bot · ${agent.name}”任务。`);
      api.output(`外部 Agent ${agent.name}，任务 ${taskId}；如需审批，请打开此任务。`);
      try {
        while (["starting", "working", "blocked"].includes(run.status)) {
          await delay(100, undefined, { signal: context.abortSignal });
          history = input.runtime.history(taskId);
          const current = history.runs.find(item => item.runId === runId);
          if (!current) throw new Error("外部 Agent 执行记录丢失，不会自动重发");
          if (current.status === "blocked" && run.status !== "blocked") input.onStatus?.(`${agent.name} 正等待审批，请在任务列表打开“Bot · ${agent.name}”任务处理。`);
          run = current;
        }
        context.abortSignal?.throwIfAborted();
        if (run.status !== "completed") throw new Error(run.error || `外部 Agent ${run.status}`);
        history = input.runtime.history(taskId);
        return { output: [{ type: "text", text: JSON.stringify({ taskId, runId, agentId: agent.id,
          answer: history.messages.find(message => message.id === run!.assistantMessageId)?.text ?? "", verification: run.verification }) }] };
      } catch (error) {
        if (context.abortSignal?.aborted) await input.runtime.cancel(runId, taskId);
        throw error;
      }
    },
  });
}
