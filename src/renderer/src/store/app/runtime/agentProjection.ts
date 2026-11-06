import type { ChatMessage, Task } from "../../../types";
import { hasActiveExecutionMessages } from "../../../utils/taskFilters";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { durableMessageToChatMessage } from "../messages/historyMapper";
import { applyPatchToMessage } from "../messages/messageReducer";
import { taskTitleFromFirstMessage } from "../messages/promptDisplay";
import type { AgentDeltaPatch } from "../types";
import { hydrateTaskMetadataFromDb } from "./taskHydration";
import { applyDurableDelta, replayDurableDeltas } from "../../../../../../shared/src/durable-sync";
import type { DurableBotDelta, DurableBotState } from "../../../../../shared/durable-bot";
import type { ChatMessageDto } from "../../../../../shared/agent-ipc";

export function createAgentProjectionActions(
  storeContext: AppContext,
): Pick<AppActions, "applyAgentPatch" | "applyAgentDeltaBatch"> {
  const { get, set } = storeContext;
  const resync = (taskId: string, delta: DurableBotDelta): void => {
    const queue = storeContext.runtime.durableResyncs.get(taskId);
    if (queue) { queue.push(delta); if (queue.length > 256) queue.shift(); return; }
    const buffered = [delta];
    const initialEpoch = get().tasks.find(task => task.id === taskId)?.durable?.epoch;
    storeContext.runtime.durableResyncs.set(taskId, buffered);
    void (async () => {
      try {
        const history = await storeContext.getApi()?.agent?.loadTaskHistory?.(taskId);
        if (!history?.durable) throw new Error("未取得持久会话的完整状态");
        const currentEpoch = get().tasks.find(task => task.id === taskId)?.durable?.epoch;
        if (currentEpoch === initialEpoch || currentEpoch === history.durable.epoch) get().applyAgentPatch({ type: "durable_snapshot", taskId, snapshot: history.durable });
        storeContext.runtime.durableResyncs.delete(taskId);
        const accepted = get().tasks.find(task => task.id === taskId)?.durable;
        if (accepted) {
          const replay = replayDurableDeltas<ChatMessageDto, DurableBotState>(accepted, buffered);
          get().applyAgentPatch({ type: "durable_snapshot", taskId, snapshot: replay.snapshot });
          if (replay.gap) throw new Error("增量仍有缺口，请重新打开会话");
        }
      } catch (error) {
        storeContext.runtime.durableResyncs.delete(taskId);
        set(state => ({ tasks: state.tasks.map(task => task.id === taskId ? { ...task, historyError: `会话同步失败：${error instanceof Error ? error.message : String(error)}` } : task) }));
      }
    })();
  };
  return {
    applyAgentPatch: (patch) => {
      // deleteTask is an explicit lifecycle boundary. Main may still emit queued/terminal events while aborting;
      // those events must never resurrect the removed task in the renderer projection or upsert it back to DB.
      if (storeContext.runtime.deletedTaskRuntimeTombstones.has(patch.taskId))
        return;

      if (patch.type === "expert_binding") {
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === patch.taskId
              ? {
                  ...task,
                  expertBinding: patch.binding,
                  expertId: patch.binding.desired?.sourceExpertId,
                }
              : task,
          ),
        }));
        return;
      }

      if (patch.type === "durable_delta") {
        if (storeContext.runtime.durableResyncs.has(patch.taskId)) { resync(patch.taskId, patch.delta); return; }
        const known = get().tasks.find(task => task.id === patch.taskId)?.durable;
        const result = applyDurableDelta<ChatMessageDto, DurableBotState>(known, patch.delta);
        if (result.kind === "resync") resync(patch.taskId, patch.delta);
        else if (result.kind === "applied") get().applyAgentPatch({ type: "durable_snapshot", taskId: patch.taskId, snapshot: result.snapshot });
        return;
      }

      if (patch.type === "durable_snapshot") {
        const snapshot = patch.snapshot;
        const known = get().tasks.find((task) => task.id === patch.taskId);
        if (
          known?.durable?.epoch === snapshot.epoch &&
          known.durable.revision >= snapshot.revision
        )
          return;
        const priorRows = new Map(known?.durable?.epoch === snapshot.epoch ? known.durable.messages.map(message => [message.id, message]) : []);
        const priorMessages = new Map(known?.messages.map(message => [message.id, message]));
        const messages: ChatMessage[] = snapshot.messages.map((message) => {
          const previous = priorMessages.get(message.id);
          if (previous && (priorRows.get(message.id) === message || (message.projectionVersion !== undefined && priorRows.get(message.id)?.projectionVersion === message.projectionVersion))) return previous;
          return {
          ...durableMessageToChatMessage(message), executionId: previous?.executionId,
          interactions: previous?.interactions, artifactIds: previous?.artifactIds, changesCount: previous?.changesCount,
          };
        });
        if (!known?.durable || known.durable.epoch === snapshot.epoch) {
          const projectedIds = new Set(messages.map(message => message.id));
          for (const previous of known?.messages ?? []) {
            if (!previous.interactions?.length || projectedIds.has(previous.id)) continue;
            const next = messages.findIndex(message => message.createdAt > previous.createdAt);
            messages.splice(next < 0 ? messages.length : next, 0, { ...previous, streaming: false });
          }
        }
        set((state) => {
          const prior = state.tasks.find((task) => task.id === patch.taskId);
          const task: Task = {
            ...prior,
            id: patch.taskId,
            welcomeMode: prior?.welcomeMode,
            durable: snapshot,
            historyWindow: prior?.historyWindow?.epoch === snapshot.epoch ? prior.historyWindow : undefined,
            historyError: undefined,
            messages,
            title:
              prior?.title ??
              taskTitleFromFirstMessage(
                snapshot.messages.find((m) => m.role === "user")?.text ?? "Bot",
              ),
            updatedAt:
              snapshot.messages.at(-1)?.createdAt ??
              prior?.updatedAt ??
              Date.now(),
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
        if (!known) hydrateTaskMetadataFromDb(storeContext, patch.taskId);
        get().reconcileTaskMessageArtifacts(patch.taskId);
        return;
      }

      if (patch.type === "user_message") {
        const needsTaskMetadataHydration = !get().tasks.some(
          (task) => task.id === patch.taskId,
        );
        set((s) => {
          let tasks = s.tasks;
          let task = tasks.find((t) => t.id === patch.taskId);
          const message: ChatMessage = {
            id: patch.messageId,
            role: "user",
            createdAt: patch.createdAt,
            blocks: [{ type: "text", text: patch.text }],
          };
          if (!task) {
            task = {
              id: patch.taskId,
              title: taskTitleFromFirstMessage(patch.text),
              updatedAt: patch.createdAt,
              messages: [message],
              status: "in_progress",
            };
            return { tasks: [task, ...tasks] };
          }
          if (task.messages.some((item) => item.id === patch.messageId))
            return s;
          const promotePlaceholderTitle =
            task.messages.length === 0 &&
            (task.title === "新任务" ||
              task.title === patch.taskId ||
              task.title.startsWith("remote-"));
          tasks = tasks.map((item) =>
            item.id === patch.taskId
              ? {
                  ...item,
                  title: promotePlaceholderTitle
                    ? taskTitleFromFirstMessage(patch.text)
                    : item.title,
                  status: "in_progress",
                  updatedAt: patch.createdAt,
                  messages: [...item.messages, message],
                }
              : item,
          );
          return { tasks };
        });
        if (needsTaskMetadataHydration)
          hydrateTaskMetadataFromDb(storeContext, patch.taskId);
        return;
      }

      if (patch.type === "compaction_status") {
        set((s) => ({
          compactionByTask: {
            ...s.compactionByTask,
            [patch.taskId]: patch.state,
          },
        }));
        return;
      }
      if (patch.type === "context_usage") {
        const activeId = get().activeTaskId;
        if (activeId && patch.taskId !== activeId) return;
        set({
          contextUsedTokens: patch.usedTokens,
          contextEstimated: patch.estimated ?? false,
          contextWindowTokens: patch.contextWindow,
          contextCacheHitRate: patch.cacheHitRate ?? null,
          contextInputTokens: patch.inputTokens ?? null,
          contextCacheReadTokens: patch.cacheReadTokens ?? null,
          contextOutputTokens: patch.outputTokens ?? null,
        });
        return;
      }

      // 重新生成两阶段提交（方案 Problem Three 5.3 Phase B）：
      // 主进程真正发出 assistant_start 时，才按 pending 记录把会话原子替换为「源用户消息 + 新回复」。
      if (patch.type === "assistant_start") {
        const pending = get().pendingRegenerations[patch.messageId];
        if (pending) {
          const pendingTask = get().tasks.find((t) => t.id === pending.taskId);
          const srcUserIdx = pendingTask?.messages.findIndex(
            (m) => m.id === pending.sourceUserMessageId,
          );
          const srcIdx = pendingTask?.messages.findIndex(
            (m) => m.id === pending.sourceAssistantMessageId,
          );
          const cleanup = (): void => {
            const { [patch.messageId]: _drop, ...rest } =
              get().pendingRegenerations;
            set({ pendingRegenerations: rest });
          };
          if (
            pendingTask &&
            srcUserIdx != null &&
            srcUserIdx >= 0 &&
            (srcIdx ?? -1) >= 0
          ) {
            const newReply: ChatMessage = {
              id: patch.messageId,
              role: "assistant",
              createdAt: Date.now(),
              blocks: [],
              modelName: patch.modelName,
              streaming: true,
            };
            const { [patch.messageId]: _drop, ...rest } =
              get().pendingRegenerations;
            set((s) => ({
              pendingRegenerations: rest,
              tasks: s.tasks.map((t) =>
                t.id === pending.taskId
                  ? {
                      ...t,
                      status: "in_progress",
                      updatedAt: Date.now(),
                      messages: [
                        ...t.messages.slice(0, srcUserIdx + 1),
                        newReply,
                      ],
                    }
                  : t,
              ),
            }));
            return; // 已按语义原子替换，不再走通用 append
          }
          // 源消息已不存在（目标被删/漂移）：只清 pending，不创建空壳
          cleanup();
          return;
        }
      }

      const needsTaskMetadataHydration = !get().tasks.some(
        (task) => task.id === patch.taskId,
      );
      set((s) => {
        // 定时任务等主进程直驱场景：侧栏可能尚未有 task / 消息占位，先补齐再打补丁，
        // 否则 assistant_start / text_delta 全部 map 不中 → 空会话 + 「已完成 0ms」。
        let tasks = s.tasks;
        let task = tasks.find((t) => t.id === patch.taskId);
        if (!task && "taskId" in patch && patch.taskId) {
          task = {
            id: patch.taskId,
            title: patch.taskId.startsWith("cron-") ? "定时任务" : "新任务",
            updatedAt: Date.now(),
            messages: [],
            status: "in_progress",
          };
          tasks = [task, ...tasks];
        }
        if (!task) return s;

        if (
          "messageId" in patch &&
          patch.messageId &&
          (patch.type === "assistant_start" ||
            patch.type === "assistant_message_start" ||
            patch.type === "conversation_interaction_snapshot" ||
            patch.type === "text_delta" ||
            patch.type === "thinking_delta" ||
            patch.type === "tool_start" ||
            patch.type === "tool_update" ||
            patch.type === "assistant_end")
        ) {
          const hasMsg = task.messages.some((m) => m.id === patch.messageId);
          if (!hasMsg) {
            const shell: ChatMessage = {
              id: patch.messageId,
              role: "assistant",
              blocks: [],
              createdAt: Date.now(),
              streaming: patch.type !== "assistant_end" && patch.type !== "conversation_interaction_snapshot",
              modelName:
                patch.type === "assistant_start" ? patch.modelName : undefined,
            };
            task = { ...task, messages: [...task.messages, shell] };
            tasks = tasks.map((t) => (t.id === task!.id ? task! : t));
          }
        }

        tasks = tasks.map((t) => {
          if (t.id !== patch.taskId) return t;
          const current = t.id === task!.id ? task! : t;

          if (patch.type === "capability_notices") {
            return { ...current, capabilityNotices: patch.notices };
          }

          if (patch.type === "conversation_goal_snapshot") {
            // 元数据快照不是新产出：推进 updatedAt 会让侧栏按 updatedAt DESC
            // 反复重排（多条任务交替变"刚刚"→ 列表来回跳），也会让已确认的
            // 完成绿点靠噪声复活。只有 assistant_start/end 才推进任务时间。
            return {
              ...current,
              activeGoal: patch.goal,
            };
          }

          if (patch.type === "artifact_ref") {
            // 3C：Artifact 本体由 Domain created/updated 事件驱动（projection → 派生视图）；
            // 这里只做消息关联 + 变更计数，不再直接写 task.artifacts。
            const fileChanges = patch.change
              ? [
                  ...(current.fileChanges ?? []),
                  {
                    id: `fc-${patch.change.name}-${Date.now()}`,
                    name: patch.change.name,
                    path: patch.change.path,
                    additions: patch.change.additions,
                    deletions: patch.change.deletions,
                  },
                ]
              : current.fileChanges;
            // 含大量图片的历史会话重放会连发几十条 artifact_ref；不要每条都把
            // task.updatedAt 刷成 now（侧栏会持续显示"刚刚"并反复重排）。
            return {
              ...current,
              fileChanges,
              messages: current.messages.map((m) =>
                m.id === patch.messageId
                  ? {
                      ...m,
                      artifactIds: [
                        ...new Set([
                          ...(m.artifactIds ?? []),
                          patch.artifactId,
                        ]),
                      ],
                      changesCount:
                        (m.changesCount ?? 0) + (patch.change ? 1 : 0),
                    }
                  : m,
              ),
            };
          }

          const messages = current.messages.map((msg) => {
            if (!("messageId" in patch) || msg.id !== patch.messageId)
              return msg;
            return applyPatchToMessage(msg, patch);
          });
          return {
            ...current,
            messages,
            updatedAt:
              patch.type === "assistant_start" || patch.type === "assistant_end"
                ? Date.now()
                : current.updatedAt,
            status:
              patch.type === "assistant_start"
                ? "in_progress"
                : patch.type === "assistant_end"
                  ? hasActiveExecutionMessages(messages)
                    ? "in_progress"
                    : patch.error
                      ? "failed"
                      : "completed"
                  : current.status,
          };
        });
        return { tasks };
      });
      if (needsTaskMetadataHydration)
        hydrateTaskMetadataFromDb(storeContext, patch.taskId);
      if (patch.type === "assistant_start" || patch.type === "assistant_end") {
        const task = get().tasks.find((item) => item.id === patch.taskId);
        if (task) {
          void storeContext.getApi()?.db?.upsertTask({
            id: task.id,
            title: task.title,
            spaceId: task.spaceId,
            status: task.status,
            updatedAt: task.updatedAt,
            sessionFile: task.sessionFile,
            cwd: task.cwd,
            modelId: task.modelId,
            permissionMode: task.permissionMode,
            welcomeMode: task.welcomeMode,
          });
        }
      }
    },

    applyAgentDeltaBatch: (patches) => {
      if (patches.length === 0) return;

      const patchesByTask = new Map<string, AgentDeltaPatch[]>();
      for (const patch of patches) {
        if (storeContext.runtime.deletedTaskRuntimeTombstones.has(patch.taskId))
          continue;
        const queued = patchesByTask.get(patch.taskId);
        if (queued) queued.push(patch);
        else patchesByTask.set(patch.taskId, [patch]);
      }

      set((s) => ({
        tasks: s.tasks.map((task) => {
          const taskPatches = patchesByTask.get(task.id);
          if (!taskPatches) return task;

          const patchesByMessage = new Map<string, AgentDeltaPatch[]>();
          for (const patch of taskPatches) {
            const queued = patchesByMessage.get(patch.messageId);
            if (queued) queued.push(patch);
            else patchesByMessage.set(patch.messageId, [patch]);
          }

          return {
            ...task,
            messages: task.messages.map((message) => {
              const messagePatches = patchesByMessage.get(message.id);
              if (!messagePatches) return message;
              return messagePatches.reduce<ChatMessage>(
                applyPatchToMessage,
                message,
              );
            }),
          };
        }),
      }));
    },
  };
}
