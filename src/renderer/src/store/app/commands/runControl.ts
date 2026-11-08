import type { ToolStatus } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

/** Stop the captured owner even if navigation changes while an IPC request is pending. */
export async function abortTask(
  storeContext: AppContext,
  taskId: string,
): Promise<void> {
  const { get, set } = storeContext;
  const owner = get().tasks.find((task) => task.id === taskId);
  const externalRun = owner?.messages.some(message => message.externalAgent && message.streaming);
  if (!externalRun && (owner?.durable || owner?.botPendingSubmission || owner?.welcomeMode === "general")) {
    await storeContext.getApi()?.agent?.abort?.(taskId);
    const history = await storeContext
      .getApi()
      ?.agent?.loadTaskHistory?.(taskId);
    const current = get().tasks.find(task => task.id === taskId)?.durable;
    if (history?.durable && (!current || current.epoch === owner?.durable?.epoch || current.epoch === history.durable.epoch))
      get().applyAgentPatch({
        type: "durable_snapshot",
        taskId,
        snapshot: history.durable,
      });
    return;
  }

  // 先本地结束流式，避免按钮卡在「停止」态
  set((s) => ({
    tasks: s.tasks.map((task) => {
      if (task.id !== taskId) return task;
      let changed = false;
      const messages = task.messages.map((msg) => {
        if (!msg.streaming) return msg;
        changed = true;
        return {
          ...msg,
          streaming: false,
          durationLabel: msg.durationLabel ?? "已停止",
          pendingBehavior: undefined,
        };
      });
      if (!changed && task.status !== "in_progress") return task;
      return {
        ...task,
        messages,
        status: task.status === "in_progress" ? "completed" : task.status,
        updatedAt: Date.now(),
      };
    }),
  }));

  await storeContext
    .getApi()
    ?.agent?.abort?.(taskId)
    .catch(() => {
      /* 主进程已结束时忽略 */
    });
  await storeContext
    .getApi()
    ?.externalAgent?.cancel?.(undefined, taskId)
    .catch(() => {
      /* 无运行中的 ACP Agent 时忽略 */
    });
}

export function createRunControlActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "abortActiveTask"
  | "resolveToolApproval"
  | "listTaskWriteGrants"
  | "revokeTaskWriteGrant"
> {
  const { get, set } = storeContext;
  return {
    abortActiveTask: async () => {
      const taskId = get().activeTaskId;
      if (taskId) await abortTask(storeContext, taskId);
    },

    resolveToolApproval: (messageId, toolCallId, approved, externalWrite) => {
      const { activeTaskId } = get();
      if (!activeTaskId) return;

      const status: ToolStatus = approved ? "running" : "denied";
      set((s) => ({
        tasks: s.tasks.map((task) => ({
          ...task,
          messages: task.messages.map((msg) =>
            msg.id !== messageId
              ? msg
              : {
                  ...msg,
                  blocks: msg.blocks.map((b) =>
                    b.type === "tool" && b.toolCall.id === toolCallId
                      ? {
                          ...b,
                          toolCall: {
                            ...b.toolCall,
                            status,
                            output: approved ? undefined : "用户已拒绝",
                          },
                        }
                      : b,
                  ),
                  ...(approved
                    ? {}
                    : {
                        streaming: false,
                        finalBlocks: [
                          ...(msg.finalBlocks ?? []),
                          {
                            type: "text" as const,
                            text: "好的，已取消该操作。",
                          },
                        ],
                      }),
                },
          ),
        })),
      }));

      void storeContext.getApi()?.agent?.approveTool({
        taskId: activeTaskId,
        toolCallId,
        approved,
        ...(externalWrite ? { externalWrite } : {}),
      });
    },

    listTaskWriteGrants: async () => {
      const taskId = get().activeTaskId;
      if (!taskId) return [];
      return (
        (await storeContext.getApi()?.db?.listTaskWriteGrants?.(taskId)) ?? []
      );
    },

    revokeTaskWriteGrant: async (path) => {
      const taskId = get().activeTaskId;
      if (!taskId) return false;
      return (
        (await storeContext
          .getApi()
          ?.db?.deleteTaskWriteGrant?.(taskId, path)) ?? false
      );
    },
  };
}
