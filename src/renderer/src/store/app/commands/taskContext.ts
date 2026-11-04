import { normalizeSingleExpertId } from "../../../../../shared/expert-id";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export function createTaskContextActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "refreshTaskExpertBinding"
  | "saveTaskExpertBinding"
  | "switchExpert"
  | "setExternalAgentPin"
  | "bindProjectContext"
> {
  const { get, set } = storeContext;
  return {
    refreshTaskExpertBinding: async (taskId) => {
      const api = storeContext.getApi()?.agent;
      if (!api?.getTaskExpertBinding)
        throw new Error("专家绑定 API 不可用，请重启更新后的应用");
      const task = get().tasks.find((item) => item.id === taskId);
      const persisted = await storeContext.getApi()?.db?.listTasks?.();
      if (task && !persisted?.some((item) => item.id === taskId))
        await storeContext
          .getApi()
          ?.db?.upsertTask?.({
            id: task.id,
            title: task.title,
            updatedAt: task.updatedAt,
            spaceId: task.spaceId,
            projectId: task.projectId,
            welcomeMode: task.welcomeMode,
            cwd: task.cwd,
            expertId: task.expertId,
          });
      const binding = await api.getTaskExpertBinding(taskId);
      set((state) => ({
        tasks: state.tasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                expertBinding: binding,
                expertId: binding.desired?.sourceExpertId,
              }
            : task,
        ),
      }));
      return binding;
    },

    saveTaskExpertBinding: async (input) => {
      const api = storeContext.getApi()?.agent;
      if (!api?.saveTaskExpertBinding)
        throw new Error("专家绑定 API 不可用，请重启更新后的应用");
      const task = get().tasks.find((item) => item.id === input.taskId);
      if (!task) throw new Error("任务不存在");
      // Some sidebar tasks have not sent their first message yet; materialize before binding.
      const persisted = await storeContext.getApi()?.db?.listTasks?.();
      if (!persisted?.some((item) => item.id === input.taskId))
        await storeContext
          .getApi()
          ?.db?.upsertTask?.({
            id: task.id,
            title: task.title,
            updatedAt: task.updatedAt,
            spaceId: task.spaceId,
            projectId: task.projectId,
            welcomeMode: task.welcomeMode,
            cwd: task.cwd,
            expertId: task.expertId,
          });
      const binding = await api.saveTaskExpertBinding(input);
      set((state) => ({
        tasks: state.tasks.map((item) =>
          item.id === input.taskId
            ? {
                ...item,
                expertBinding: binding,
                expertId: binding.desired?.sourceExpertId,
                ...(binding.desired
                  ? {}
                  : { lastAnnouncedExpertId: undefined }),
              }
            : item,
        ),
      }));
      return binding;
    },

    switchExpert: (expertId) => {
      const next =
        expertId == null ? null : (normalizeSingleExpertId(expertId) ?? null);
      if (expertId != null && !next) return;
      const taskId = get().activeTaskId;
      if (!taskId) {
        // 草稿态（任务未落库）：记入 draft，首条消息 materialize 时随任务生效。
        // 无 draft 时也要创建，否则「只选专家再发送」会丢 expertId。
        set((s) => ({
          draft: s.draft
            ? { ...s.draft, expertId: next ?? undefined }
            : next
              ? { expertId: next }
              : null,
        }));
        return;
      }
      void get()
        .saveTaskExpertBinding({ taskId, expertId: next })
        .catch((error) => {
          console.error("[switchExpert]", error);
          set((state) => ({
            tasks: state.tasks.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    botInputError:
                      error instanceof Error ? error.message : String(error),
                  }
                : task,
            ),
          }));
        });
    },

    setExternalAgentPin: (pin) => {
      const taskId = get().activeTaskId;
      if (!taskId) {
        // 草稿态：记入 draft，首条消息 materialize 时随任务落库（与 expertId 同路径）。
        set((s) => ({
          draft: s.draft
            ? { ...s.draft, externalAgentPin: pin ?? undefined }
            : pin
              ? { externalAgentPin: pin }
              : null,
        }));
        return;
      }
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === taskId ? { ...t, externalAgentPin: pin ?? undefined } : t,
        ),
      }));
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      void storeContext.getApi()?.db?.upsertTask?.({
        id: taskId,
        title: task.title,
        updatedAt: Date.now(),
        externalAgentPin: pin,
      });
    },

    bindProjectContext: (taskId, projectId) => {
      const task = get().tasks.find((item) => item.id === taskId);
      if (!task) return;
      const updatedAt = Date.now();
      set((state) => ({
        tasks: state.tasks.map((item) =>
          item.id === taskId
            ? { ...item, projectId: projectId ?? undefined, updatedAt }
            : item,
        ),
      }));
      void storeContext.getApi()?.db?.upsertTask?.({
        id: task.id,
        title: task.title,
        updatedAt,
        projectId,
      });
    },
  };
}
