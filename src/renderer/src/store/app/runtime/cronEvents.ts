import { normalizeSingleExpertId } from "../../../../../shared/expert-id";
import type { ChatMessage, Task } from "../../../types";
import type { RuntimeBinding } from "./binding";

export function bindCronEvents(
  binding: RuntimeBinding,
  formatDuration: (milliseconds?: number) => string | undefined,
): void {
  const {
    context: { get, set },
    api,
    isActive,
    addCleanup,
  } = binding;

  addCleanup(
    api.cron?.onEvent?.((event: unknown) => {
      if (!isActive()) return;
      const current = event as {
        type?: string;
        run?: { taskId?: string; status?: string; jobId?: string };
      };
      if (current?.type !== "run" || !current.run?.taskId) return;
      const taskId = current.run.taskId;
      const runStatus = current.run.status;

      void (async () => {
        const rows = (await api.db?.listTasks?.()) ?? [];
        if (!isActive()) return;
        const row = rows.find((task) => task.id === taskId);
        if (!row) return;

        const mapped: Task = {
          id: row.id,
          title: row.title,
          spaceId: row.spaceId ?? undefined,
          projectId: row.projectId ?? undefined,
          status:
            (row.status as Task["status"]) ??
            (runStatus === "success"
              ? "completed"
              : runStatus === "error"
                ? "failed"
                : "in_progress"),
          updatedAt: row.updatedAt,
          messages: [],
          sessionFile: row.sessionFile,
          cwd: row.cwd,
          modelId: row.modelId ?? get().activeModelId,
          permissionMode: row.permissionMode,
          welcomeMode: row.welcomeMode,
          archived: row.archived,
          expertId: normalizeSingleExpertId(row.expertId),
          expertBinding: row.expertBinding,
          modePresetId: row.modePresetId,
          startAt: row.startAt ?? undefined,
          dueAt: row.dueAt ?? undefined,
          externalAgentPin: row.externalAgentPin ?? undefined,
        };

        set((state) => {
          const exists = state.tasks.some((task) => task.id === taskId);
          if (!exists) return { tasks: [mapped, ...state.tasks] };
          return {
            tasks: state.tasks.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    title:
                      row.title &&
                      row.title !== "定时任务" &&
                      row.title !== "新任务"
                        ? row.title
                        : task.title,
                    status: mapped.status ?? task.status,
                    sessionFile: row.sessionFile ?? task.sessionFile,
                    cwd: row.cwd ?? task.cwd,
                    modelId: row.modelId ?? task.modelId,
                    updatedAt: Date.now(),
                  }
                : task,
            ),
          };
        });

        // Keep the existing completed-run recovery policy separate from ordinary history hydration.
        if (runStatus === "success" || runStatus === "error") {
          const task = get().tasks.find((item) => item.id === taskId);
          const needHistory =
            !task ||
            task.messages.length === 0 ||
            !task.messages.some(
              (message) =>
                message.role === "assistant" &&
                ((message.finalBlocks?.some(
                  (block) => block.type === "text" && block.text.trim(),
                ) ??
                  false) ||
                  message.blocks.some(
                    (block) => block.type === "text" && block.text.trim(),
                  )),
            );
          if (needHistory) {
            try {
              const history = await api.agent?.loadTaskHistory?.(taskId);
              if (!isActive() || !history?.messages?.length) return;
              const restored: ChatMessage[] = history.messages.map(
                (message) => ({
                  id: message.id,
                  role: message.role,
                  createdAt: message.createdAt,
                  modelName: message.modelName,
                  externalAgent: message.externalAgent,
                  durationLabel: formatDuration(message.durationMs),
                  entryId: message.entryId,
                  attachments: message.attachments,
                  blocks:
                    message.role === "user"
                      ? [{ type: "text" as const, text: message.text }]
                      : [
                          ...(message.thinking
                            ? [
                                {
                                  type: "thinking" as const,
                                  text: message.thinking,
                                },
                              ]
                            : []),
                          ...(message.tools ?? []).map((tool) => ({
                            type: "tool" as const,
                            toolCall: { ...tool },
                          })),
                        ],
                  finalBlocks:
                    message.role === "assistant" && message.text
                      ? [{ type: "text" as const, text: message.text }]
                      : undefined,
                  artifactIds: message.artifactIds,
                  streaming: false,
                }),
              );
              set((state) => ({
                tasks: state.tasks.map((item) =>
                  item.id === taskId
                    ? {
                        ...item,
                        messages: restored,
                        sessionFile: history.sessionFile ?? item.sessionFile,
                        cwd: history.cwd ?? item.cwd,
                        title:
                          row.title && row.title !== "定时任务"
                            ? row.title
                            : item.title,
                        updatedAt: Date.now(),
                      }
                    : item,
                ),
              }));
            } catch {
              /* ignore history hydrate errors */
            }
          }
        }
      })();
    }),
  );
}
