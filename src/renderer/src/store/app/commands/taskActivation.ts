import { defaultModePresetId } from "../../../../../shared/mode-profile";
import { setHistoryArtifactHints } from "../../../lib/messageArtifactReconcile";
import type { HistoryArtifactHint } from "../../../lib/messageArtifactReconcile";
import { PANEL_RAIL_WIDTH } from "../../../lib/panelWidth";
import type { ChatMessage } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { formatDuration } from "../format";

export function createTaskActivationActions(
  storeContext: AppContext,
): Pick<AppActions, "setActiveTask"> {
  const { get, set } = storeContext;
  return {
    setActiveTask: (id) => {
      const s = get();
      const task = s.tasks.find((t) => t.id === id);
      // 3E：首个产物 tab 从 projection 取（task.artifacts 已退役；未 hydrate 时为空，hydrate 后事件补齐）
      const first = s.artifactProjection.artifactsByTask[id]?.[0]?.id ?? null;
      const hasMessages = (task?.messages.length ?? 0) > 0;
      const taskModelId =
        task?.modelId &&
        s.models.some(
          (model) => model.id === task.modelId && model.enabled !== false,
        )
          ? task.modelId
          : s.activeModelId;
      const keepPanel = s.panelPinned && s.panelOpen;
      set({
        activeTaskId: id,
        // 切到具体任务 = 丢弃草稿（首条消息未发出即不存在）
        draft: null,
        // 工作空间选择跟随当前任务：独立任务清空 homeSpaceId，避免发消息时被上次空间偷绑
        homeSpaceId: task?.spaceId ?? null,
        // 抓取元素引用不跨任务：切任务即清理
        chatSelections: [],
        // 终端上下文不跨任务：切任务即清理（终端 PTY 本身在主进程按 taskId 保活）
        terminalContext: null,
        // 子代理临时 Chat 不跨任务：切任务即关闭（实例为 task-scoped disposable）
        subagentDrawer: undefined,
        // 产物「发送到对话」挂起项不跨任务
        pendingRefFile: null,
        // 分享任务挂起项不跨任务（shareTaskToConversation 在 setActiveTask 之后再写入）
        pendingRefTask: null,
        pendingExternalAgentContinuation: null,
        page: "chat",
        panelOpen: keepPanel,
        panelMode: keepPanel
          ? s.panelMode === "file" && !first
            ? hasMessages
              ? "overview"
              : s.extensionView
            : s.panelMode
          : hasMessages
            ? "overview"
            : "file",
        extensionView: keepPanel
          ? s.extensionView
          : hasMessages
            ? "overview"
            : "overview",
        extensionFlyoutOpen: false,
        extensionFlyoutPinned: false,
        extensionMenuOpen: false,
        panelExpanded: keepPanel ? s.panelExpanded : false,
        panelWidth: keepPanel ? s.panelWidth : PANEL_RAIL_WIDTH,
        sidebarBeforePanelExpand: keepPanel ? s.sidebarBeforePanelExpand : null,
        artifactTabs: first ? [first] : [],
        activeArtifactId: first,
        selectMode: false,
        selectedMessageIds: [],
        contextUsedTokens: null,
        contextEstimated: false,
        activeModelId: taskModelId,
        // F2：显式标记任务级隔离（不跨任务泄漏；新任务/继承值 = false）
        modelExplicit: task?.modelExplicit ?? false,
        contextWindowTokens:
          get().models.find((model) => model.id === taskModelId)
            ?.contextWindow || get().contextWindowTokens,
        permissionMode: task?.permissionMode ?? get().permissionMode,
        permissionExplicit: task?.permissionExplicit ?? false,
        fullAccessDuringRun:
          (task?.permissionMode ?? get().permissionMode) === "auto",
        welcomeMode: task?.welcomeMode ?? get().welcomeMode,
        // Active 连接器随任务切换（任务级；新任务/草稿为 []）
        activeConnectorIds: task?.connectorIds ?? [],
        // 全局 selection 跟随任务模式：任务已有 preset 用之，否则该模式默认（保证合法）
        modePresetId:
          task?.modePresetId ??
          defaultModePresetId(task?.welcomeMode ?? get().welcomeMode),
      });
      // 打开任务 = 看过结果：清掉「已结束」绿点（持久化，重启不再亮）。仅对已结束未确认的任务写库。
      void get().ackTaskDone(id);
      const hydrateConversationRuntime = (): void => {
        void storeContext
          .getApi()
          ?.conversationRuntime?.snapshot(id)
          .then((snapshot) => {
            set((state) => ({
              tasks: state.tasks.map((candidate) => {
                if (candidate.id !== id) return candidate;
                const assistantMessages = candidate.messages.filter(
                  (message) => message.role === "assistant",
                );
                const resolveHistoricalMessageId = (
                  messageId: string,
                  createdAt: number,
                ): string => {
                  if (
                    assistantMessages.some(
                      (message) => message.id === messageId,
                    )
                  )
                    return messageId;
                  const nearest = assistantMessages.reduce<
                    ChatMessage | undefined
                  >((best, message) => {
                    if (!best) return message;
                    return Math.abs(message.createdAt - createdAt) <
                      Math.abs(best.createdAt - createdAt)
                      ? message
                      : best;
                  }, undefined);
                  return nearest?.id ?? messageId;
                };
                const interactionsByMessage = new Map<
                  string,
                  typeof snapshot.interactions
                >();
                for (const interaction of snapshot.interactions) {
                  const resolvedMessageId = resolveHistoricalMessageId(
                    interaction.assistantMessageId,
                    interaction.createdAt,
                  );
                  const list =
                    interactionsByMessage.get(resolvedMessageId) ?? [];
                  list.push(interaction);
                  interactionsByMessage.set(resolvedMessageId, list);
                }
                return {
                  ...candidate,
                  activeGoal: snapshot.activeGoal,
                  messages: candidate.messages.map((message) => ({
                    ...message,
                    interactions:
                      interactionsByMessage.get(message.id) ??
                      message.interactions,
                  })),
                };
              }),
            }));
          })
          .catch((error) =>
            console.warn(
              "[appStore] conversation runtime hydrate failed",
              error,
            ),
          );
      };
      hydrateConversationRuntime();
      void storeContext
        .getApi()
        ?.agent?.getContextUsage?.(id)
        .then((usage) => {
          if (!usage || get().activeTaskId !== id) return;
          set({
            contextUsedTokens: usage.usedTokens,
            contextEstimated: usage.estimated ?? false,
            contextWindowTokens: usage.contextWindow,
            contextCacheHitRate: usage.cacheHitRate ?? null,
            contextInputTokens: usage.inputTokens ?? null,
            contextCacheReadTokens: usage.cacheReadTokens ?? null,
            contextOutputTokens: usage.outputTokens ?? null,
          });
        });

      // Wave 3A：active task 强制 hydrate（未加载 → loading → snapshot → ready/error）
      void get().hydrateArtifacts(id);
      // 对话分支血缘：来源 chip + 子分支列表（切换任务即刷新）
      get().refreshBranchLineage(id);

      // 重启后 messages 为空时，从 session jsonl 恢复聊天记录
      // 3B.1：History 只恢复对话（messages/session/cwd）；Artifact 恢复唯一源 = Artifact Domain
      // （首次 hydrate 时 Main 侧一次性 legacy migration，见 ArtifactDomainSetup.ensureTaskLegacyMigrated）
      if (
        !hasMessages ||
        get().tasks.find((task) => task.id === id)?.welcomeMode === "bot"
      ) {
        void storeContext
          .getApi()
          ?.agent?.loadTaskHistory?.(id)
          .then(async (history) => {
            if (history.durable) {
              get().applyAgentPatch({
                type: "durable_snapshot",
                taskId: id,
                snapshot: history.durable,
              });
              // 模型目录收缩后主进程会把失效的任务模型修复为可解析模型：这里同步任务与输入框，
              // 否则输入框会继续显示旧的（已不存在的）模型，与实际执行不一致。
              const repairedModelId =
                history.modelId &&
                get().models.some(
                  (model) =>
                    model.id === history.modelId && model.enabled !== false,
                )
                  ? history.modelId
                  : undefined;
              set((s) => ({
                tasks: s.tasks.map((t) =>
                  t.id === id
                    ? {
                        ...t,
                        sessionRecovery: history.sessionRecovery,
                        historyError: history.historyError,
                        modelRecovery: history.modelRecovery,
                        modelId: history.modelId ?? t.modelId,
                      }
                    : t,
                ),
                ...(s.activeTaskId === id && repairedModelId
                  ? { activeModelId: repairedModelId }
                  : {}),
              }));
              return;
            }
            const combinedHistoryMessages = history.messages ?? [];
            // 异步结果按目标 taskId 回填；切去其它任务不应丢弃已读出的历史。
            // 当前任务专属 UI 状态仍在下方按 activeTaskId 守卫，避免影响新页面。
            // 3B.1：Artifact 真源 = Domain；历史里的 hist-art-* 只作 name/path 线索
            const hints: HistoryArtifactHint[] = (history.messages ?? [])
              .filter((m) => (m.artifacts ?? []).length > 0)
              .map((m) => ({
                messageId: m.id,
                items: (m.artifacts ?? []).map((a) => ({
                  name: a.name,
                  path: a.path,
                })),
              }));
            setHistoryArtifactHints(id, hints);

            const restored: ChatMessage[] = combinedHistoryMessages.map((m) => {
              const referencedPaths = new Set(
                (m.taskReferences ?? [])
                  .flatMap((reference) => reference.files ?? [])
                  .map((file) => file.path?.toLowerCase())
                  .filter((path): path is string => Boolean(path)),
              );
              const displayAttachments = (m.attachments ?? []).filter(
                (attachment) =>
                  !attachment.path ||
                  !referencedPaths.has(attachment.path.toLowerCase()),
              );
              return {
                id: m.id,
                role: m.role,
                createdAt: m.createdAt,
                modelName: m.modelName,
                externalAgent: m.externalAgent,
                durationLabel: formatDuration(m.durationMs),
                entryId: m.entryId,
                attachments: displayAttachments.length
                  ? displayAttachments
                  : undefined,
                selectionLabels: m.selectionLabels,
                blocks:
                  m.role === "user"
                    ? [{ type: "text" as const, text: m.text }]
                    : [
                        ...(m.thinking
                          ? [{ type: "thinking" as const, text: m.thinking }]
                          : []),
                        ...(m.tools ?? []).map((tool) => ({
                          type: "tool" as const,
                          toolCall: { ...tool },
                        })),
                      ],
                finalBlocks:
                  m.role === "assistant" && m.text
                    ? [{ type: "text" as const, text: m.text }]
                    : undefined,
                // Pi hist-art-* remains a hint; delegated runs may already carry trusted Domain ids.
                artifactIds: m.artifactIds,
                taskReferences: m.taskReferences?.map((reference) => ({
                  taskId: reference.taskId,
                  title: reference.title,
                  spaceName: reference.spaceName,
                  files: (reference.files ?? []).map((file, index) => ({
                    id: file.id ?? `${id}-ref-${index}-${file.name}`,
                    name: file.name,
                    path: file.path,
                    source: file.source,
                  })),
                })),
                streaming: false,
              };
            });
            set((s) => ({
              tasks: s.tasks.map((t) =>
                t.id === id
                  ? {
                      ...t,
                      messages: restored.length ? restored : t.messages,
                      sessionFile: history.sessionFile ?? t.sessionFile,
                      cwd: history.cwd ?? t.cwd,
                      sessionRecovery: history.sessionRecovery,
                      historyError: history.historyError,
                    }
                  : t,
              ),
              ...(s.activeTaskId === id ? { panelOpen: false } : {}),
            }));
            hydrateConversationRuntime();
            // Domain 若已 ready（hydrate 先完成）立刻对账；否则等 hydrate 回调
            get().reconcileTaskMessageArtifacts(id);
          })
          .catch((error: unknown) => {
            // 历史加载失败必须可见：空 projection 会渲染成「等待第一条消息」，
            // 把真实的存储损坏/占用伪装成正常空会话（真实事故：用户看到空白 Bot 会话）。
            const message =
              error instanceof Error ? error.message : String(error);
            console.warn("[appStore] loadTaskHistory failed", id, error);
            set((s) => ({
              tasks: s.tasks.map((t) =>
                t.id === id ? { ...t, historyError: message } : t,
              ),
            }));
          });
      }
    },
  };
}
