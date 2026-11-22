import type { Cursor } from "@earendil-works/pi-durable";
import type { GoalCompletionObservation } from "../work/WorkClosureMutations";
import { dotsInputVersion } from "../../dots/DotsNativeIntent";
import { currentDurableInvocation } from "./DurableExecutionContext";

export interface GoalObservationQuote {
  criterionId?: string;
  quote: string;
  toolCallId?: string;
}

const controlTools = new Set(["request_user_input", "dots_action"]);
const acknowledgment = /^(?:我(?:已经|已)?|本轮|任务|目标|事项|工作)?(?:已(?:经)?|都|全部)?\s*(?:做好了|做完了|已完成|完成了?|通过了?|满足了?|已结项|已交付|已核对|核对完成|确认|收到|没问题|done|completed|successfully completed)[。.!！\s]*$/iu;

/** Resolve quotes from retained native result entries and reject copied inputs. */
export async function readGoalObservations(origin: string, operation: string, quotes: GoalObservationQuote[]): Promise<GoalCompletionObservation[]> {
  const active = currentDurableInvocation();
  const conversationId = active?.presentationConversationId;
  if (!active || conversationId === undefined || !quotes.length)
    throw new Error("请引用本次交办的实际文字成果或成功工具结果");
  const requested = quotes.map(item => ({ ...item, quote: item.quote.trim() }));
  if (requested.some(item => !item.quote || acknowledgment.test(item.quote))) throw new Error("请引用可交付内容或观测事实");
  return active.native.commit(async tx => {
    const current = await tx.submissionByRequest(conversationId, operation);
    const [, latest] = JSON.parse(await dotsInputVersion(tx, conversationId)) as [number, number];
    if (current?.type !== "input" || current.id !== latest) throw new Error("原执行已收到更新要求，请按最新意图核对");
    const assignment = await tx.submissionByRequest(conversationId, origin);
    if (assignment?.type !== "input" || !assignment.entry) throw new Error("原交办的执行回执不可用");

    const matches = requested.map(() => [] as GoalCompletionObservation[]);
    const userInputs: Array<{ type: string; text?: string }> = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId, minEntryId: assignment.entry, order: "descending" }, 100, cursor);
      for (const entry of page.items) {
        for (const message of entry.model ?? []) {
          if (message.role === "user") {
            userInputs.push(...(typeof message.content === "string" ? [{type:"text",text:message.content}] : message.content));
            continue;
          }
          if (message.role === "system") continue;
          if (message.role === "toolResult" && (message.isError || controlTools.has(message.toolName)
            || message.toolName.startsWith("conversation_goal_"))) continue;

          for (const [index, item] of requested.entries()) {
            if (item.toolCallId && (message.role !== "toolResult" || message.toolCallId !== item.toolCallId)) continue;
            if (!message.content.some(block => block.type === "text" && block.text.includes(item.quote))) continue;
            matches[index].push({
              criterionId: item.criterionId,
              sourceRef: `durable:${active.execution.taskId}:${conversationId}:${entry.id}`,
              detail: item.quote,
              kind: message.role === "toolResult" ? "tool_receipt" : "inspection",
            });
          }
        }
      }
      cursor = page.next;
    } while (cursor);

    return matches.map((candidates, index) => {
      const { quote } = requested[index];
      const suppliedByUser = userInputs.some(block => block.type === "text" && block.text?.includes(quote));
      const recorded = candidates.find(item => item.kind === "tool_receipt") ?? (suppliedByUser ? undefined : candidates[0]);
      if (!recorded) throw new Error("有验收依据未在本次交办的原生结果中找到。请从真实结果中逐字引用一段原文");
      return recorded;
    });
  }, active.context);
}
