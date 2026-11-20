import { isGatewayConversation } from "../../../../../shared/gateway-task";
import type { TaskHistoryDto } from "../../../../../shared/agent-ipc";
import type { AppContext } from "../context";
import type { DurableBotHistory } from "../../../../../shared/durable-bot";
import type { ChatMessage, Task } from "../../../types";
import { durableMessageToChatMessage } from "../messages/historyMapper";
import { taskTitleFromFirstMessage } from "../messages/promptDisplay";
import { advanceActivity } from "../../../../../../shared/src/activity-time";
import { hydrateTaskMetadataFromDb } from "./taskHydration";

/** A later read of this task, or a newer writer, owns its projection. */
export async function readTaskHistory(
  context: AppContext, taskId: string, accept?: (history: TaskHistoryDto) => void,
): Promise<"durable" | "other" | "superseded"> {
  const { taskHistoryReads, deletedTaskRuntimeTombstones } = context.runtime;
  const current = () => context.get().tasks.find(task => task.id === taskId)?.durable;
  const initial = current();
  const request = Symbol();
  taskHistoryReads.set(taskId, request);
  const ownsRead = () => taskHistoryReads.get(taskId) === request && !deletedTaskRuntimeTombstones.has(taskId);
  try {
    const history = await context.getApi()?.agent?.loadTaskHistory?.(taskId);
    if (!ownsRead()) return "superseded";
    const latest = current();
    const read = history?.durable;
    if (latest !== initial && (read?.epoch === undefined || latest?.epoch !== read.epoch))
      return "superseded";
    if (read?.epoch !== undefined && latest?.epoch === read.epoch && latest.revision > read.revision)
      return "superseded";
    if (read) projectDurableHistory(context, taskId, read);
    if (history) accept?.(history);
    return read ? "durable" : "other";
  } catch (error) {
    if (!ownsRead() || current() !== initial) return "superseded";
    throw error;
  } finally {
    if (taskHistoryReads.get(taskId) === request) taskHistoryReads.delete(taskId);
  }
}

export function projectDurableHistory(storeContext: AppContext, taskId: string, snapshot: DurableBotHistory): void {
  const { get, set } = storeContext;
  if (storeContext.runtime.deletedTaskRuntimeTombstones.has(taskId)) return;
  const known = get().tasks.find((task) => task.id === taskId);
  if (snapshot.epoch !== undefined && storeContext.runtime.retiredDurableEpochs.get(taskId)?.has(snapshot.epoch)) return;
  if (known?.durable?.epoch !== undefined && known.durable.epoch !== snapshot.epoch) {
    const retired = storeContext.runtime.retiredDurableEpochs.get(taskId) ?? new Set<string>();
    retired.add(known.durable.epoch);
    storeContext.runtime.retiredDurableEpochs.set(taskId, retired);
  }
  if (
    snapshot.epoch !== undefined && known?.durable?.epoch === snapshot.epoch &&
    known.durable.revision >= snapshot.revision
  )
    return;
  const priorRows = new Map(snapshot.epoch !== undefined && known?.durable?.epoch === snapshot.epoch ? known.durable.messages.map(message => [message.id, message]) : []);
  const priorMessages = new Map(known?.durable && known.durable.historyId !== snapshot.historyId ? [] : known?.messages.map(message => [message.id, message]));
  const messages: ChatMessage[] = snapshot.messages.map((message) => {
    const previous = priorMessages.get(message.id);
    if (previous && (priorRows.get(message.id) === message || (message.projectionVersion !== undefined && priorRows.get(message.id)?.projectionVersion === message.projectionVersion))) return previous;
    return {
      ...durableMessageToChatMessage(message), executionId: previous?.executionId,
      interactions: previous?.interactions, artifactIds: previous?.artifactIds, changesCount: previous?.changesCount,
    };
  });
  if (!known?.durable || (known.durable.historyId === snapshot.historyId && known.durable.epoch === snapshot.epoch)) {
    const projectedIds = new Set(messages.map(message => message.id));
    for (const previous of known?.messages ?? []) {
      if (!previous.interactions?.length || projectedIds.has(previous.id)) continue;
      const next = messages.findIndex(message => message.createdAt > previous.createdAt);
      messages.splice(next < 0 ? messages.length : next, 0, { ...previous, streaming: false });
    }
  }
  set((state) => {
    const prior = state.tasks.find((task) => task.id === taskId);
    const localInputs = prior?.botPendingSubmissions;
    const acknowledged = localInputs?.length ? new Set([
      ...snapshot.messages.map(message => message.inputRequestId),
      ...snapshot.pendingInputs.map(input => input.inputRequestId),
    ]) : undefined;
    const remaining = acknowledged ? localInputs?.filter(input => !acknowledged.has(input.id)) : localInputs;
    const task: Task = {
      ...prior,
      id: taskId,
      welcomeMode: prior?.welcomeMode,
      durable: snapshot,
      historyWindow: prior?.historyWindow?.historyId === snapshot.historyId ? prior.historyWindow : undefined,
      historyError: undefined,
      messages,
      botPendingSubmissions: remaining?.length ? remaining : undefined,
      title:
        prior?.title ??
        taskTitleFromFirstMessage(
          snapshot.messages.find((m) => m.role === "user")?.text ?? "新任务",
        ),
      // 任务时间只取主进程回填的权威活动时间（DB 单调投影），不再从消息时间自己推：
      // 占位行的 createdAt 不是事实，旧写法会让侧栏出现 epoch 0（“20774 天”）。
      updatedAt: advanceActivity(prior?.updatedAt, snapshot.activityAt),
      status: snapshot.busy
        ? "in_progress"
        : snapshot.error || snapshot.outcome === "failed"
          ? "failed"
          : snapshot.outcome === "completed"
            ? "completed"
            : "pending",
    };
    return {
      tasks: prior
        ? state.tasks.map((item) => (item.id === task.id ? task : item))
        : [task, ...state.tasks],
    };
  });
  if (!known || (isGatewayConversation(taskId) && !known.gatewaySidebarChannelId)) {
    hydrateTaskMetadataFromDb(storeContext, taskId);
  }
  get().reconcileTaskMessageArtifacts(taskId);
}
