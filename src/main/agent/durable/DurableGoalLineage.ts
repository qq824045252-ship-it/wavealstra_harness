import { GenerationTask, LiveDoc, type HookApi, type Storage, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { GoalActivityAdmission } from "../../../shared/conversation-goal-activity";
import { DurableSubagentIdentity } from "./DurableSubagentIdentity";
import { durableInputAuditSchema } from "./DurableSkillProjection";

export async function durableGoalToolGeneration(api: ToolExecutionApi, context: Context): Promise<GoalActivityAdmission["parent"]> {
  return api.commit(async tx => {
    let id: TaskId | undefined = api.taskId;
    while (id !== undefined) {
      const task = await tx.task(id);
      if (!task) break;
      if (task.kind === GenerationTask.definition.name) return { conversationId: String(task.conversationId), generationTaskId: id };
      id = task.owner ?? (await tx.conversation(task.conversationId))?.owner?.taskId;
    }
    return undefined;
  }, context);
}

export async function nativeGoalParentGeneration(storage: Storage, owner: TaskId | undefined,
  context: Context): Promise<GoalActivityAdmission["parent"]> {
  while (owner !== undefined) {
    const task = await storage.task(owner, context);
    if (!task) break;
    if (task.kind === GenerationTask.definition.name) return { conversationId: String(task.conversationId), generationTaskId: owner };
    owner = task.owner;
  }
  return undefined;
}

export async function durableGoalAdmission(
  storage: Storage, api: HookApi, context: Context, child: boolean,
): Promise<GoalActivityAdmission> {
  const identity = { conversationId: String(api.conversationId), generationTaskId: api.taskId };
  if (child) {
    const record = await storage.conversation(api.conversationId, context);
    const parent = await nativeGoalParentGeneration(storage, record?.owner?.taskId, context);
    if (!parent) return identity;
    const subagent = (await api.snapshot(DurableSubagentIdentity, api.conversationId, context))?.value?.item;
    return { ...identity, parent,
      ...(subagent ? { child: { id: subagent.id, displayName: subagent.displayName,
        role: subagent.agentName, model: subagent.selection.model } } : {}) };
  }

  const live = await api.snapshot(LiveDoc, api.conversationId, context);
  const inputs: NonNullable<GoalActivityAdmission["inputs"]> = [];
  for (const submissionId of live?.run?.inputs ?? []) {
    const submission = await storage.submission(submissionId, context);
    const entryId = submission?.entry;
    const entry = entryId === undefined ? undefined : await api.entry(entryId, context);
    const data = entry?.data;
    const metadata = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
    const parsed = durableInputAuditSchema.safeParse(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.audit : undefined);
    if (!parsed.success || !parsed.data.goalOwner) return identity;
    inputs.push({ owner: parsed.data.goalOwner, assistantMessageId: parsed.data.assistantMessageId });
  }
  return { ...identity, inputs };
}
