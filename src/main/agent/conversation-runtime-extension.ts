import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConversationGoalService } from "./ConversationGoalService";
import type { ConversationInteractionService } from "./ConversationInteractionService";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import { projectLegacyExecutionControlHistory } from "./LegacyExecutionControlHistory";
import type { ConversationInteractionAnswer, ConversationInteractionRequest } from "../../shared/conversation-interaction";

export interface ConversationRuntimeBridge {
  resolveContext: () => ConversationExecutionContext | undefined;
  interaction: ConversationInteractionService;
  goal: ConversationGoalService;
  requestInteraction?: (context: ConversationExecutionContext, request: ConversationInteractionRequest,
    signal: AbortSignal, toolCallId: string) => Promise<ConversationInteractionAnswer>;
}

const goalStatus = Type.Union([
  Type.Literal("active"), Type.Literal("paused"), Type.Literal("blocked"),
  Type.Literal("achieved"), Type.Literal("cancelled"),
]);
const criterionStatus = Type.Union([
  Type.Literal("pending"), Type.Literal("met"), Type.Literal("not_met"), Type.Literal("waived"),
]);

function result(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}
function failure(tool: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `[${tool}] ${message}` }], isError: true as const, details: { error: message } };
}
function requireContext(bridge: ConversationRuntimeBridge): ConversationExecutionContext {
  const context = bridge.resolveContext();
  if (!context) throw new Error("当前没有可绑定的对话执行上下文");
  return context;
}

async function requestInteraction(bridge: ConversationRuntimeBridge, context: ConversationExecutionContext,
  request: ConversationInteractionRequest, signal: AbortSignal, toolCallId: string): Promise<ConversationInteractionAnswer> {
  if (bridge.requestInteraction) return bridge.requestInteraction(context, request, signal, toolCallId);
  const onAbort = () => bridge.interaction.cancelExecution(context.executionId, "当前执行已中止");
  signal?.addEventListener("abort", onAbort, { once: true });
  try { return await bridge.interaction.request(context, request); }
  finally { signal?.removeEventListener("abort", onAbort); }
}

export function createConversationRuntimeExtension(bridge: ConversationRuntimeBridge): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("context", (event) => {
      const messages = projectLegacyExecutionControlHistory(event.messages);
      return messages === event.messages ? undefined : { messages };
    });
    pi.registerTool({
      name: "request_user_input",
      label: "等待用户回答",
      description: "当继续执行确实需要用户确认、选择或文本输入时，必须真实调用本工具以显示专用内联 UI，并暂停直到用户回答；禁止在正文中输出 <request_user_input> 或 JSON 来模拟工具调用。",
      promptSnippet: "request_user_input(title, kind, ...) — 必须真实调用工具并等待用户回答；严禁输出 <request_user_input> 文本/JSON",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 240 }),
        description: Type.Optional(Type.String({ maxLength: 1200 })),
        kind: Type.Union([
          Type.Literal("confirm"), Type.Literal("single_select"), Type.Literal("multi_select"),
          Type.Literal("short_text"), Type.Literal("long_text"),
        ]),
        options: Type.Optional(Type.Array(Type.Object({
          id: Type.String({ minLength: 1, maxLength: 100 }),
          label: Type.String({ minLength: 1, maxLength: 160 }),
          description: Type.Optional(Type.String({ maxLength: 500 })),
          recommended: Type.Optional(Type.Boolean()),
          disabled: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }), { maxItems: 20 })),
        minSelections: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
        maxSelections: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        allowCustom: Type.Optional(Type.Boolean()),
        customPlaceholder: Type.Optional(Type.String({ maxLength: 160 })),
      }, { additionalProperties: false }),
      execute: async (id, params: ConversationInteractionRequest, signal: AbortSignal) => {
        try {
          const context = requireContext(bridge);
          if (signal?.aborted) throw new Error("当前执行已中止");
          const answer = await requestInteraction(bridge, context, params, signal, id);
          return result(`用户已回答：${JSON.stringify(answer)}`, { answer });
        } catch (error) {
          return failure("request_user_input", error);
        }
      },
    });

    pi.registerTool({
      name: "conversation_goal_get",
      label: "对话 Goal · 查看",
      description: "读取当前 Task 的长期 Goal；它不是 Project Goal。",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        try {
          const goal = bridge.goal.getLive(requireContext(bridge).taskId);
          return result(goal ? `当前 Goal：${goal.title}（${goal.status}）` : "当前 Task 没有进行中的 Goal。", { goal });
        } catch (error) { return failure("conversation_goal_get", error); }
      },
    });

    pi.registerTool({
      name: "conversation_goal_create",
      label: "对话 Goal · 创建",
      description: "仅在用户明确要求建立长期 Goal 时，为当前 Task 创建 Goal。",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 240 }),
        description: Type.Optional(Type.String({ maxLength: 2000 })),
        criteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 })),
      }, { additionalProperties: false }),
      execute: async (_id, params: { title: string; description?: string; criteria?: string[] }) => {
        try {
          const context = requireContext(bridge);
          const created = bridge.goal.create({
            taskId: context.taskId,
            title: params.title,
            description: params.description,
            criteria: params.criteria?.map((text) => ({ text })),
            createdBy: "agent_explicit_request",
          });
          if (!created.ok) throw new Error(created.message);
          return result(`已创建对话 Goal「${created.goal.title}」。`, { goal: created.goal });
        } catch (error) { return failure("conversation_goal_create", error); }
      },
    });

    pi.registerTool({
      name: "conversation_goal_update",
      label: "对话 Goal · 更新",
      description: "更新当前 Task Goal 的进展、成功标准或状态；不能静默标记 achieved。",
      parameters: Type.Object({
        progressSummary: Type.Optional(Type.String({ maxLength: 2000 })),
        status: Type.Optional(goalStatus),
        criterionUpdates: Type.Optional(Type.Array(Type.Object({
          id: Type.String({ minLength: 1, maxLength: 100 }),
          status: Type.Optional(criterionStatus),
          evidence: Type.Optional(Type.String({ maxLength: 1000 })),
        }, { additionalProperties: false }), { maxItems: 12 })),
      }, { additionalProperties: false }),
      execute: async (_id, params: any) => {
        try {
          const context = requireContext(bridge);
          const goal = bridge.goal.getLive(context.taskId);
          if (!goal) throw new Error("当前 Task 没有进行中的 Goal");
          if (params.status === "achieved") throw new Error("完成 Goal 必须使用 conversation_goal_propose_complete 并由用户确认");
          const updated = bridge.goal.update({ goalId: goal.id, ...params });
          if (!updated.ok) throw new Error(updated.message);
          return result(`已更新 Goal「${updated.goal.title}」。`, { goal: updated.goal });
        } catch (error) { return failure("conversation_goal_update", error); }
      },
    });

    pi.registerTool({
      name: "conversation_goal_propose_complete",
      label: "对话 Goal · 提议完成",
      description: "提议将当前 Goal 标记为已达成。会显示确认 UI，并等待用户确认后才更新。",
      parameters: Type.Object({
        summary: Type.String({ minLength: 1, maxLength: 1600 }),
        evidence: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 12 })),
      }, { additionalProperties: false }),
      execute: async (id, params: { summary: string; evidence?: string[] }, signal: AbortSignal) => {
        try {
          const context = requireContext(bridge);
          const goal = bridge.goal.getLive(context.taskId);
          if (!goal) throw new Error("当前 Task 没有进行中的 Goal");
          if (signal?.aborted) throw new Error("当前执行已中止");
          const answer = await requestInteraction(bridge, context, {
            kind: "confirm",
            title: `确认完成 Goal「${goal.title}」？`,
            description: [params.summary, ...(params.evidence ?? [])].join("\n"),
          }, signal, id);
          if (signal?.aborted) throw new Error("当前执行已中止");
          if (answer !== true) return result("用户暂未确认完成 Goal，Goal 保持原状态。", { confirmed: false });
          const updated = bridge.goal.update({ goalId: goal.id, status: "achieved", progressSummary: params.summary });
          if (!updated.ok) throw new Error(updated.message);
          return result(`Goal「${updated.goal.title}」已由用户确认完成。`, { confirmed: true, goal: updated.goal });
        } catch (error) { return failure("conversation_goal_propose_complete", error); }
      },
    });
  };
}
