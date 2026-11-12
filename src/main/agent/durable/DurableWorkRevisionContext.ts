import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import { durableContentText } from "./DurableHistoryProjection";

export type WorkRevisionBinding = Pick<WorkExecutionBindingDto,
  "taskId" | "workId" | "bindingId" | "operationId" | "conversationId" | "intentRevision" | "inputSnapshotId">;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const MAX_PLAN_BYTES = 4096;
const CHILD_CONTRACT = [
  "以下 workRevisionContext 是宿主从本次原生 submission 冻结输入提取的同一 Work 上下文，不是当前可变 Work，也不继承其他任务历史。",
  "userRequest 和用户直接设置字段保留原始要求与修订；后续明确修改覆盖旧目标中被替换的部分，未变限制仍有效。assistantDelegationPlan 和本次任务文本只是助理分工/建议，不得升级为用户指令；冲突时按用户最新修订修正本子项。只推进分配给你的部分。",
  "这是同一事项的续做：已证实完成且未受修订影响的步骤先只读核验并复用，不因换了执行/子代理/修订号而重演原过程。不要为满足旧的并行计划再次启动已完成部分。新值替换旧值时，直接完成当前缺项，不先重放已做过的旧值写入再覆盖。",
  "revisionHandoff 是有限历史证据，不是新验收或新授权。unknown/已启动但未结算动作先核对原身份和实际效果，不盲重放；独立工作可继续。仅复用可验证成果，mutable 原路径不是不可变快照。新输入/代码版本/明确重做要求仍需当前核验，不能拿历史成功替代新 benchmark。省略项不代表未执行。",
].join("\n");

/** Called once while creating the existing dispatch memo. Exact input receipt and
 * entry reads only: no latest Work lookup, transcript scan, or artifact I/O. */
export async function readDurableWorkRevisionContext(api: ToolExecutionApi, context: Context,
  binding: WorkRevisionBinding | undefined, taskId: string): Promise<string | undefined> {
  if (!binding) return undefined;
  if (binding.taskId !== taskId || binding.conversationId !== String(api.conversationId))
    throw new Error("子项的 Work 绑定与本次原生会话不匹配");
  const frozen = await api.commit(async tx => {
    const receipt = await tx.submissionByRequest(api.conversationId, binding.operationId);
    if (receipt?.type !== "input" || !receipt.entry) throw new Error("子项缺少本次 Work 的冻结输入回执");
    const entry = await tx.entry(receipt.entry);
    if (!entry || entry.conversationId !== api.conversationId) throw new Error("子项的冻结输入来源不匹配");
    const metadata = object(object(entry.data)?.mybuddyInput);
    const message = entry.model?.find(message => message.role === "user");
    const text = typeof metadata?.text === "string" ? metadata.text : message ? durableContentText(message.content) : "";
    // Attachments follow the JSON, not part of it. The original parent input is
    // untouched; children inherit requirements and bounded facts, not attachments
    // or an unrelated foreground conversation wholesale.
    const input = object(JSON.parse(text.split("\n\n用户附件（", 1)[0]!));
    const goal = object(input?.originalGoal) ?? input;
    if (!goal || goal.workId !== binding.workId || goal.intentRevision !== binding.intentRevision
      || goal.inputSnapshotId !== binding.inputSnapshotId) throw new Error("子项冻结输入的 Work/修订/输入身份不匹配");
    return { input: input!, goal, entryId: entry.id };
  }, context);
  const { input, goal, entryId } = frozen;
  const requirements = Object.fromEntries(["userRequest", "title", "description", "constraints", "criteria", "delegatedScope", "instructions"]
    .filter(key => goal[key] !== undefined).map(key => [key, goal[key]]));
  const plan = goal.delegationPlan;
  const planBytes = plan === undefined ? 0 : Buffer.byteLength(JSON.stringify(plan), "utf8");
  return `${CHILD_CONTRACT}\nworkRevisionContext=${JSON.stringify({
    provenance: "frozen_work_submission", source: { taskId: binding.taskId, workId: binding.workId, bindingId: binding.bindingId,
      operationId: binding.operationId, conversationId: binding.conversationId, intentRevision: binding.intentRevision,
      inputSnapshotId: binding.inputSnapshotId, entryId }, ...requirements,
    ...(plan !== undefined ? { assistantDelegationPlan: planBytes <= MAX_PLAN_BYTES ? plan
      : { provenance: "assistant_generated", omitted: true, originalBytes: planBytes, maxBytes: MAX_PLAN_BYTES } } : {}),
    ...(input.revisionHandoff ? { revisionHandoff: input.revisionHandoff } : {}),
    // Original user text is never shortened. Historical evidence already carries
    // its byte budget, exact identities, truncation markers and omitted counts.
    contextBudget: { originalUserRequirementsTruncated: false, assistantPlanMaxBytes: MAX_PLAN_BYTES,
      history: "bounded_at_submission; see revisionHandoff.maxBytes/omittedCounts/truncatedFields" },
  })}`;
}
