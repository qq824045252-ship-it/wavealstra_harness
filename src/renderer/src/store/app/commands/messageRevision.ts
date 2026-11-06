import { mergeHistoryWindow } from "../../../lib/historyWindow";
import type { AgentRegenerateResult } from "../../../../../shared/agent-ipc";
import { normalizedEditorTextHash } from "../../../../../shared/regenerate-hash";
import {
  toRequestModelId,
  toRequestPermissionMode,
} from "../../../lib/sessionContract";
import type { ChatMessage } from "../../../types";
import { hasActiveExecutionMessages } from "../../../utils/taskFilters";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { uid } from "../runtime/ids";
import { abortTask } from "./runControl";

export function createMessageRevisionActions(
  storeContext: AppContext,
): Pick<AppActions, "deleteUserMessage" | "regenerateMessage"> {
  const { get, set } = storeContext;
  return {
    deleteUserMessage: async (messageId) => {
      const { activeTaskId } = get();
      if (!activeTaskId) return;
      const task = get().tasks.find((item) => item.id === activeTaskId);
      if (!task) return;
      const messages = task.historyWindow ? mergeHistoryWindow([task.historyWindow.messages], task.messages) : task.messages;
      const messageIndex = messages.findIndex(
        (message) => message.id === messageId,
      );
      if (messageIndex < 0 || messages[messageIndex]?.role !== "user")
        return;
      const targetEntryId = messages[messageIndex].entryId;
      const userMessageIndex =
        messages
          .slice(0, messageIndex + 1)
          .filter((message) => message.role === "user").length - 1;
      if (userMessageIndex < 0) return;

      // 任务仍在执行时主进程会拒绝删除。与安卓端「停止并删除」对齐：先停止当前运行，
      // 再短暂重试（abort 收尾是异步的），避免删除入口在长任务上变成死胡同。
      if (
        hasActiveExecutionMessages(task.messages) ||
        task.status === "in_progress"
      ) {
        await abortTask(storeContext, activeTaskId).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      const api = storeContext.getApi()?.agent;
      if (api?.deleteUserMessage) {
        let lastError: unknown;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            await api.deleteUserMessage({
              taskId: activeTaskId,
              userMessageIndex,
              entryId: targetEntryId,
            });
            lastError = undefined;
            break;
          } catch (cause) {
            lastError = cause;
            const text = cause instanceof Error ? cause.message : String(cause);
            if (!/执行|停止|busy|conflict/i.test(text)) throw cause;
            await abortTask(storeContext, activeTaskId).catch(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
        }
        if (lastError) throw lastError;
        const history = await api.loadTaskHistory?.(activeTaskId);
        if (history?.durable) {
          get().applyAgentPatch({ type: "durable_snapshot", taskId: activeTaskId, snapshot: history.durable });
          return;
        }
      }

      const remaining = messages.slice(0, messageIndex);
      const nextStatus = remaining.length === 0 ? "pending" : "completed";
      set((state) => ({
        tasks: state.tasks.map((item) =>
          item.id === activeTaskId
            ? {
                ...item,
                messages: remaining,
                status: nextStatus,
                updatedAt: Date.now(),
              }
            : item,
        ),
      }));
    },

    regenerateMessage: (messageId) => {
      const { activeTaskId } = get();
      if (!activeTaskId) return;
      const task = get().tasks.find((t) => t.id === activeTaskId);
      if (!task) return;
      const messages = task.historyWindow ? mergeHistoryWindow([task.historyWindow.messages], task.messages) : task.messages;

      const idx = messages.findIndex((m) => m.id === messageId);
      const sourceAssistant = messages[idx];
      if (!sourceAssistant || sourceAssistant.role !== "assistant") return;
      // 两阶段提交只允许对已终结的助手回复执行；源消息自身仍 streaming 时不在此路径进入。
      if (sourceAssistant.streaming) return;

      // 目标消息之后仍有消息在流式生成 → 不可重新生成（避免与正跑执行争夺叶子）
      if (task.messages.some(m => m.streaming)) return;

      // 定位被重生成的源用户消息 + 它在会话中的 0-based 用户序号
      let userIdx = idx - 1;
      while (userIdx >= 0 && messages[userIdx]?.role !== "user")
        userIdx -= 1;
      const sourceUser = userIdx >= 0 ? messages[userIdx] : undefined;
      if (!sourceUser) return;
      // 与主进程 SDK getUserMessagesForForking() 对齐：只统计「有正文文本」的用户消息。
      // SDK 侧过滤 text 非空的 user entry（contentText join 后非空），若 UI 侧把无文本
      // 用户消息（纯附件等）也计入序号，两边索引错位 → 静默 TARGET_NOT_FOUND。
      const hasForkableUserText = (m: ChatMessage): boolean =>
        (m.blocks ?? [])
          .filter((b) => b.type === "text")
          .map((b) => ("text" in b ? (b.text ?? "") : ""))
          .join("\n") !== "";
      if (!hasForkableUserText(sourceUser)) return;
      const userMessageIndex =
        messages
          .slice(0, userIdx + 1)
          .filter((m) => m.role === "user" && hasForkableUserText(m)).length -
        1;
      if (userMessageIndex < 0) return;

      // pending 去重：同一源助手消息已在重试中 → 忽略本次点击
      const alreadyPending = Object.values(get().pendingRegenerations).some(
        (p) =>
          p.taskId === activeTaskId && p.sourceAssistantMessageId === messageId,
      );
      if (alreadyPending) return;

      const {
        models,
        activeModelId,
        modelExplicit,
        permissionMode,
        permissionExplicit,
        welcomeMode: defaultWelcomeMode,
      } = get();
      const welcomeMode = task.welcomeMode ?? defaultWelcomeMode;
      const newAssistantMsgId = uid(storeContext);
      const requestId = uid(storeContext);

      // 两阶段 Phase A：不截断、不插空壳；只登记 pending + 清源消息旧错误标记。
      // 原助手回复在 assistant_start 到达前始终保持完整。
      set((s) => ({
        pendingRegenerations: {
          ...s.pendingRegenerations,
          [newAssistantMsgId]: {
            requestId,
            taskId: activeTaskId,
            sourceAssistantMessageId: messageId,
            sourceUserMessageId: sourceUser.id,
            userMessageIndex,
            newAssistantMessageId: newAssistantMsgId,
            startedAt: Date.now(),
          },
        },
        tasks: s.tasks.map((t) =>
          t.id === activeTaskId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === messageId ? { ...m, generateError: undefined } : m,
                ),
              }
            : t,
        ),
      }));

      const api = storeContext.getApi();
      const failPending = (message: string): void => {
        const pending = get().pendingRegenerations[newAssistantMsgId];
        if (!pending) return;
        const { [newAssistantMsgId]: _drop, ...rest } =
          get().pendingRegenerations;
        set((s) => ({
          pendingRegenerations: rest,
          // 旧消息完整保留，仅在源助手消息上挂用户可见错误
          tasks: s.tasks.map((t) =>
            t.id === pending.taskId
              ? {
                  ...t,
                  ...(t.durable ? { botInputError: message } : {}),
                  messages: t.messages.map((m) =>
                    m.id === pending.sourceAssistantMessageId
                      ? { ...m, generateError: message }
                      : m,
                  ),
                }
              : t,
          ),
        }));
      };

      if (!api?.agent?.regenerate) {
        failPending("（主进程 Agent API 未就绪，重新生成失败，原回复已保留）");
        return;
      }

      // 源用户消息文本指纹（drift 校验：主进程定位到的 editorText 应一致）
      const sourceUserText = (sourceUser.blocks ?? [])
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? (b.text ?? "") : ""))
        .join(" ");

      // 重新生成不改空间归属：只用任务自身 spaceId（不用 homeSpaceId 兜底）
      const spaceId = task.spaceId ?? undefined;
      void api.agent
        .regenerate({
          taskId: activeTaskId,
          requestId,
          userMessageIndex,
          assistantMessageId: newAssistantMsgId,
          sourceAssistantMessageId: messageId,
          sourceUserMessageId: sourceUser.id,
          sourceUserEntryId: sourceUser.entryId,
          expectedUserTextHash: normalizedEditorTextHash(sourceUserText),
          modelId: toRequestModelId({
            explicit: modelExplicit,
            value: activeModelId,
          }),
          permissionMode: toRequestPermissionMode({
            explicit: permissionExplicit,
            value: permissionMode,
          }),
          welcomeMode,
          spaceId,
          expertId: task.expertId,
          modePresetId: task.modePresetId,
          // 任务级 Active 连接器：会话重建时私有技能保持一致
          connectorIds: task.connectorIds,
        })
        .then(async (result: AgentRegenerateResult | undefined) => {
          // 主进程明确失败（含 navigate cancelled 等）：旧消息保留 + 用户可见错误
          if (result && !result.ok) {
            // 附上失败 code（NAVIGATION_CANCELLED / TARGET_DRIFTED / …），
            // tooltip 可显示具体原因，便于定位与反馈。
            failPending(
              `[${result.code}] ${result.message || "重新生成失败，原回复已保留。"}`,
            );
            return;
          }
          const history = await api.agent.loadTaskHistory?.(activeTaskId);
          if (result?.ok && history?.durable) {
            get().applyAgentPatch({ type: "durable_snapshot", taskId: activeTaskId, snapshot: history.durable });
            const { [newAssistantMsgId]: _pending, ...pendingRegenerations } = get().pendingRegenerations;
            set({ pendingRegenerations });
            return;
          }
          if (result?.ok && result.userEntryId) {
            set((s) => ({
              tasks: s.tasks.map((t) =>
                t.id === activeTaskId &&
                t.messages.some((m) => m.id === newAssistantMsgId)
                  ? {
                      ...t,
                      messages: t.messages.map((m) =>
                        m.id === sourceUser.id
                          ? { ...m, entryId: result.userEntryId }
                          : m,
                      ),
                    }
                  : t,
              ),
            }));
          }
          // regenerate IPC 在 prompt 结束后才返回；正常的 assistant_start 已先完成 commit。
          // 若仍 pending，说明本次没有启动回复，不能永久占住去重锁。
          failPending("重新生成未启动，原回复已保留，请重试。");
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("[appStore] regenerate IPC failed", err);
          failPending(message || "重新生成失败，原回复已保留。");
        });
    },
  };
}
