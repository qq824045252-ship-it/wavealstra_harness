import { LiveDoc, type EntryRecord, type SubmissionRecord, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { z } from "zod";
import { nativeExecutionSucceeded } from "../../../shared/native-execution-receipt";
import { DOTS_WORK_ITEM_ID_PATTERN } from "../../dots/DotsWorkerOutcome";
import { checkDurableInputFreshness } from "./DurableInputFreshness";
import { durableSourceInput } from "./DurableInputProvenance";
import { PROJECT_CHECK_NAME_PATTERN } from "./DurableProjectVerification";

export const DOTS_TASK_END = "dots_task_end";

const dependency = z.object({
  operationId: z.string().min(1),
  title: z.string(),
  deadlineAt: z.number().int().positive(),
});

const workEvidence = z.array(z.strictObject({
  id: z.string().regex(new RegExp(DOTS_WORK_ITEM_ID_PATTERN)),
  evidence: z.string().trim().min(1).max(1800),
})).max(48);

const outcome = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete"), result: z.string(), deliveryText: z.string(),
    verifiedCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
    completedItems: workEvidence.optional(),
    verifiedChecks: z.array(z.string().regex(new RegExp(PROJECT_CHECK_NAME_PATTERN))).max(25).optional() }),
  z.object({ action: z.literal("wait"), progress: z.string(), dependencyWait: dependency }),
]);
const receipt = z.object({ dotsTerminal: z.object({ operationId: z.string(), outcome }) });
type Dependency = z.infer<typeof dependency>;
type TerminalOutcome = z.infer<typeof outcome>;

function decodeToolArray(value: unknown): unknown {
  // Some OpenAI-compatible model routes encode arrays as JSON strings. Pi may
  // coerce that string to a one-element array while validating the tool schema.
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (typeof candidate !== "string" || !candidate.trimStart().startsWith("[")) return value;
  try { return JSON.parse(candidate); }
  catch { return value; }
}

const checkNames = z.preprocess(decodeToolArray, z.array(z.string().max(128).regex(new RegExp(PROJECT_CHECK_NAME_PATTERN))).max(25));

const argsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("complete"),
    result: z.string().max(16000),
    deliveryText: z.string().max(32000),
    checks: checkNames.optional(),
    commitSha: z.string().regex(/^[a-f0-9]{7,64}$/i).optional(),
    completedItems: z.preprocess(decodeToolArray, workEvidence).optional(),
  }),
  z.object({
    action: z.literal("wait"),
    progress: z.string().min(1).max(1800),
    dependencyOperationId: z.string().min(1).max(160),
  }),
]);
type WorkerArgs = z.infer<typeof argsSchema>;
type VerifyCompletion = (
  proof: Pick<Extract<WorkerArgs, { action: "complete" }>, "checks" | "commitSha" | "completedItems">,
  api: ToolExecutionApi, context: Context, operationId: string,
) => Promise<{ verifiedCommit?: string; verifiedChecks?: string[] }>;

export function createDurableDotsWorker(
  taskId: string,
  isActive: (taskId: string, operationId: string) => boolean,
  validateDependency: (taskId: string, operationId: string, dependencyOperationId: string) => Dependency,
  verifyCompletion: VerifyCompletion,
): ToolRegistration {
  return {
    name: DOTS_TASK_END,
    description: "结束当前 Dots 后台交办的模型执行。请单独调用。complete 在实际验收和约定交付都已完成后提交回原对话的正文。用 completedItems 逐项说明带 work ID 的事项实际产生的结果和依据，用 checks 引用 project_verify 的必验检查，用 commitSha 引用已授权并实际存在的本地提交。wait 在独立工作已完成、只能等待同一交办里的另一任务时保存进展并暂停，传入对方委派回执里的 operationId。不使用 shell sleep 轮询。",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("complete"),
        result: Type.String({ maxLength: 16000 }),
        deliveryText: Type.String({ maxLength: 32000 }),
        checks: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 25 })),
        commitSha: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{7,64}$" })),
        completedItems: Type.Optional(Type.Union([
          Type.Array(Type.Object({
            id: Type.String({ pattern: DOTS_WORK_ITEM_ID_PATTERN }),
            evidence: Type.String({ minLength: 1, maxLength: 1800 }),
          }, { additionalProperties: false }), { maxItems: 48 }),
          Type.String({ pattern: "^\\s*\\[", description: "JSON 编码的同一组完成项。" }),
        ])),
      }, { additionalProperties: false }),
      Type.Object({
        action: Type.Literal("wait"),
        progress: Type.String({ minLength: 1, maxLength: 1800 }),
        dependencyOperationId: Type.String({ minLength: 1, maxLength: 160 }),
      }, { additionalProperties: false }),
    ]),
    replay: "safe",
    callers: ["model"],
    execute: async (raw, api, context) => {
      const parsed = argsSchema.safeParse(raw);
      if (!parsed.success) return toolError("请提供有效的结项参数。checks 只包含 typecheck、test 或 test: 开头的项目检查名称。");
      const args = parsed.data;
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      if (live?.tools?.length !== 1 || live.tools[0]?.taskId !== api.taskId)
        return toolError("请在主任务的单独一个工具调用中结束或暂停交办。");
      const source = await durableSourceInput(api, context, api.conversationId, live.run?.inputs ?? []);
      if (!source || !isActive(taskId, source.id))
        return toolError("当前执行没有可结束的 Dots 后台交办。");
      let terminal: TerminalOutcome;
      try {
        if (args.action === "wait") {
          if (!args.progress.trim()) return toolError("请说明已经完成的进展和正在等待什么。");
          terminal = { action: "wait", progress: args.progress.trim(),
            dependencyWait: validateDependency(taskId, source.id, args.dependencyOperationId) };
        } else {
          if (!args.result.trim() && !args.deliveryText.trim()) return toolError("请提供执行结果或交付正文。");
          const proof = await verifyCompletion(args, api, context, source.id);
          terminal = { action: "complete", result: args.result, deliveryText: args.deliveryText,
            ...(proof.verifiedCommit ? { verifiedCommit: proof.verifiedCommit } : {}),
            ...(args.completedItems?.length ? { completedItems: args.completedItems } : {}),
            ...(proof.verifiedChecks?.length ? { verifiedChecks: proof.verifiedChecks } : {}) };
        }
        await checkDurableInputFreshness(api, context);
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        return toolError(error instanceof Error ? error.message : String(error));
      }
      if (!isActive(taskId, source.id)) return toolError("原交办已发生变化，未结束本次执行。");
      return {
        output: [{ type: "text", text: terminal.action === "wait" ? "已交给 Dots 等待依赖。" : "已提交原交办结果。" }],
        details: { dotsTerminal: { operationId: source.id, outcome: terminal } },
        control: { terminate: true },
      };
    },
  };
}

function toolError(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true };
}

/** Only a settled single-call native turn may supply a worker outcome. */
export async function readDurableDotsTerminal(tx: Tx, input: Extract<SubmissionRecord, { type: "input" }>,
  final: EntryRecord | undefined): Promise<TerminalOutcome | undefined> {
  if (input.status !== "done" || final?.id !== input.answer || final.conversationId !== input.conversationId) return;
  const answer = final.model?.find(message => message.role === "assistant");
  if (answer?.stopReason !== "toolUse") return;
  const calls = answer.content.filter(part => part.type === "toolCall");
  if (calls.length !== 1 || calls[0].name !== DOTS_TASK_END) return;
  const callId = calls[0].id;
  // Pi commits the tool result after the assistant entry. The next user input is a different turn.
  const page = await tx.scanEntries({ conversationId: input.conversationId, minEntryId: input.answer, order: "ascending" }, 64);
  for (const entry of page.items) {
    if (entry.id === input.answer) continue;
    if (entry.kind === "pi.user" || entry.kind === "mybuddy.user" || entry.kind === "pi.assistant") return;
    const result = entry.model?.find(message => message.role === "toolResult" && message.toolCallId === callId && message.toolName === DOTS_TASK_END);
    if (result?.role !== "toolResult" || !nativeExecutionSucceeded(result, {
      conversationId: input.conversationId, toolTaskId: entry.byTaskId, toolName: DOTS_TASK_END, callId,
    })) continue;
    const parsed = receipt.safeParse(result.details);
    if (parsed.success && parsed.data.dotsTerminal.operationId === input.requestId)
      return parsed.data.dotsTerminal.outcome;
  }
}
