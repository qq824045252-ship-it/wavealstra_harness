import { mergeHistoryWindow } from "../../../lib/historyWindow";
import type { CreateConversationBranchRequest } from "../../../../../shared/conversation-branch";
import type { Task } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { abortTask } from "./runControl";

export function createConversationBranchActions(
  storeContext: AppContext,
): Pick<AppActions, "createBranchFromMessage" | "refreshBranchLineage"> {
  const { get, set } = storeContext;
  return {
    createBranchFromMessage: async (messageId, opts) => {
      const state = get();
      if (!state.conversationBranchEnabled) return false;
      const taskId = state.activeTaskId;
      if (!taskId || state.branchCreatingTaskId === taskId) return false;
      const task = state.tasks.find((t) => t.id === taskId);
      const messages = task?.historyWindow ? mergeHistoryWindow([task.historyWindow.messages], task.messages) : task?.messages ?? [];
      // 过滤后 UI 序号（辅助锚点；主锚点是 entryId，§7.1）
      const targetIndex = messages.findIndex(
        (message) => message.id === messageId,
      );
      if (targetIndex < 0 && !opts.entryId) return false;
      const userMessageIndex =
        messages
          .slice(0, targetIndex + 1)
          .filter((message) => message.role === "user").length - 1;
      if (userMessageIndex < 0 && !opts.entryId) return false;
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      set({ branchCreatingTaskId: taskId, branchError: null });
      try {
        const request: CreateConversationBranchRequest = {
          sourceTaskId: taskId,
          entryId: opts.entryId,
          userMessageIndex: userMessageIndex >= 0 ? userMessageIndex : undefined,
          position: opts.role === "user" ? "after_user" : "after_reply",
          requestId,
        };
        let result = await storeContext
          .getApi()
          ?.conversationBranch?.create(request);
        // 任务仍在执行时主进程返回 TASK_BUSY：与安卓端「停止并删除」同构，
        // 先停止请求所属任务的运行再重试（requestId 不变，重复请求返回同一个 child）。
        for (
          let attempt = 0;
          result && !result.ok && result.code === "TASK_BUSY" && attempt < 3;
          attempt += 1
        ) {
          await abortTask(storeContext, taskId).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 700));
          result = await storeContext
            .getApi()
            ?.conversationBranch?.create(request);
        }
        if (!result) {
          set({ branchCreatingTaskId: null });
          return false;
        }
        if (!result.ok) {
          set({
            branchCreatingTaskId: null,
            branchError: {
              taskId,
              message:
                result.code === "TASK_BUSY"
                  ? "任务仍在收尾：已停止当前运行，请稍后再点一次「从这里创建分支」。"
                  : result.message,
            },
          });
          return false;
        }
        const child = result.result.task;
        const task: Task = {
          id: child.id,
          title: child.title,
          spaceId: child.spaceId,
          projectId: child.projectId,
          status: child.status,
          updatedAt: child.updatedAt,
          sessionFile: child.sessionFile,
          cwd: child.cwd,
          welcomeMode: child.welcomeMode,
          modelId: child.modelId,
          permissionMode: child.permissionMode,
          archived: child.archived,
          expertId: child.expertId,
          modePresetId: child.modePresetId,
          startAt: child.startAt,
          dueAt: child.dueAt,
          spaceSortOrder: child.spaceSortOrder,
          isFavorited: child.isFavorited,
          messages: [],
          connectorIds: state.activeConnectorIds,
        };
        set((s) => ({
          tasks: [task, ...s.tasks],
          branchCreatingTaskId: null,
          branchError: null,
        }));
        // setActiveTask 内自动：hydrateArtifacts + loadTaskHistory + context usage
        get().setActiveTask(child.id);
        get().refreshBranchLineage(taskId);
        return true;
      } catch (err) {
        set({
          branchCreatingTaskId: null,
          branchError: {
            taskId,
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return false;
      }
    },

    refreshBranchLineage: (taskId) => {
      const api = storeContext.getApi()?.conversationBranch;
      if (!api) {
        set((s) =>
          s.activeTaskId === taskId
            ? { branchSource: null, branchChildren: [] }
            : {},
        );
        return;
      }
      void Promise.all([api.getInfo(taskId), api.listChildren(taskId)])
        .then(([source, children]) => {
          if (get().activeTaskId !== taskId) return; // 不污染其它任务
          set({ branchSource: source ?? null, branchChildren: children ?? [] });
        })
        .catch(() => {
          if (get().activeTaskId !== taskId) return;
          set({ branchSource: null, branchChildren: [] });
        });
    },
  };
}
