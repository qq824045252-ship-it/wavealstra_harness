import { resolveExternalAgentContinuationRunId } from "../../../../../shared/external-agent";
import { defaultModePresetId } from "../../../../../shared/mode-profile";
import { normalizeSelectionComment } from "../../../../../shared/selection";
import {
  toRequestModelId,
  toRequestPermissionMode,
} from "../../../lib/sessionContract";
import type { Attachment, ChatMessage, Task } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import {
  taskTitleFromFirstMessage,
  userVisiblePromptText,
} from "../messages/promptDisplay";
import { uid } from "../runtime/ids";

export function createSendMessageActions(
  storeContext: AppContext,
): Pick<AppActions, "sendMessage"> {
  const { get, set } = storeContext;
  return {
    sendMessage: (
      text,
      attachments,
      taskReferences,
      streamingBehavior,
      connectorIds,
      explicitOverrides,
      externalAgent,
    ) => {
      let { activeTaskId } = get();
      let materializedPlanId: string | undefined;
      if (!activeTaskId) {
        // 草稿态（点「新建任务」/召唤专家后尚未发过消息）：此刻才创建任务并激活，
        // 随后按现有流程连同首条消息一起落库。未发消息的任务不会出现在列表/空间里。
        const state = get();
        materializedPlanId = state.draft?.planId;
        const task: Task = {
          id: uid(storeContext),
          title: state.draft?.title?.trim() || "新任务",
          spaceId: state.draft?.spaceId ?? undefined,
          projectId: state.draft?.projectId,
          updatedAt: Date.now(),
          messages: [],
          modelId: state.activeModelId,
          permissionMode: state.permissionMode,
          welcomeMode: state.welcomeMode,
          expertId: state.draft?.expertId,
          modePresetId:
            state.modePresetId ?? defaultModePresetId(state.welcomeMode),
          // 草稿期 pin 的 ACP Agent 随首条消息写入任务（任务级语义）
          externalAgentPin: state.draft?.externalAgentPin,
          // 草稿期挂载的 Active 连接器随首条消息写入任务（任务级语义）
          connectorIds: state.activeConnectorIds,
          // F2：materialize 继承当前（草稿期可能已显式选择的）标记
          modelExplicit: state.modelExplicit,
          permissionExplicit: state.permissionExplicit,
        };
        activeTaskId = task.id;
        set((s) => ({
          tasks: [task, ...s.tasks],
          activeTaskId: task.id,
          draft: null,
        }));
        // 新任务 materialize：hydrate 空 projection（快速 ready）
        void get().hydrateArtifacts(task.id);
      }

      const {
        tasks,
        models,
        activeModelId,
        modelExplicit,
        permissionMode,
        permissionExplicit,
        welcomeMode: defaultWelcomeMode,
      } = get();
      const task = tasks.find((x) => x.id === activeTaskId);
      if (!task) return;
      const welcomeMode = task.welcomeMode ?? defaultWelcomeMode;
      const isGeneral = task.welcomeMode === "general";

      // ACP 路由：瞬态选择（+ 菜单/「继续」按钮）优先；任务级 pin 兜底并自动续接
      // 最近一个可恢复 run。「本轮新会话」= 不带 continueFromRunId 的同 agent 瞬态选择，
      // 走瞬态分支，pin 保持不变；新 run 随后自动成为续链新头。
      const pinnedAgent = task.externalAgentPin;
      const effectiveExternalAgent = isGeneral
        ? undefined
        : (externalAgent ??
          (pinnedAgent
            ? {
                id: pinnedAgent.id,
                name: pinnedAgent.name,
                protocol: "acp" as const,
                continueFromRunId: resolveExternalAgentContinuationRunId(
                  task.messages,
                  pinnedAgent.id,
                ),
              }
            : undefined));

      const isDurable = !effectiveExternalAgent;

      // 显式 vs 默认契约（P0）：用户显式选择过才作为 explicit 传主进程，否则 undefined，
      // 由主进程按 Tag 建议 → Mode 建议 → 系统默认链解析；createRelatedTask 等已解析场景
      // 通过 explicitOverrides 直接注入（等价于显式）。
      const reqModelId =
        explicitOverrides?.modelId !== undefined
          ? explicitOverrides.modelId
          : toRequestModelId({ explicit: modelExplicit, value: activeModelId });
      const reqPermissionMode =
        explicitOverrides?.permissionMode !== undefined
          ? explicitOverrides.permissionMode
          : toRequestPermissionMode({
              explicit: permissionExplicit,
              value: permissionMode,
            });

      // 「加入聊天」抓取元素：仅 pending 引用随本条消息发送；发送即消费（不无限复用）。
      // 实际内容由主进程 AgentService 发送时经 PromptContextService 解析（指纹不匹配不注入）。
      const pendingSelections = get().chatSelections.filter(
        (item) => item.status === "pending",
      );
      const selectionRefs = pendingSelections.map((item) => ({
        comment: normalizeSelectionComment(item.comment),
        artifactId: item.artifactId,
        artifactVersion: item.artifactVersion,
        surfaceGeneration: item.surfaceGeneration,
        backendNodeId: item.backendNodeId,
      }));
      // 气泡摘要在清空 pending 前先落下来，否则发送后引用芯片会消失
      const selectionLabelsForBubble = pendingSelections
        .map((item) =>
          item.comment
            ? `${item.label.trim()}：${item.comment}`
            : item.label.trim(),
        )
        .filter(Boolean);
      set({ chatSelections: [] });

      // 「终端 → 加入对话」：显式附加上下文随本条消息发送，发送即消费（不无限复用）
      const terminalCtx = get().terminalContext;
      const terminalForBubble = terminalCtx?.text?.trim()
        ? {
            source: terminalCtx.source,
            charCount: terminalCtx.text.length,
            preview: terminalCtx.text.slice(0, 240),
          }
        : undefined;
      set({ terminalContext: null });

      const userMsgId = uid(storeContext);
      const assistantMsgId = uid(storeContext);
      const atts = (attachments ?? []).filter((a) => a.name);
      const referencedPaths = new Set(
        (taskReferences ?? [])
          .flatMap((reference) => reference.files ?? [])
          .map((file) => file.path?.toLowerCase())
          .filter((path): path is string => Boolean(path)),
      );
      const displayAttachments = atts.filter(
        (attachment) =>
          !attachment.path ||
          !referencedPaths.has(attachment.path.toLowerCase()),
      );
      // 气泡正文只存说明文字；技能/MCP/连接器以前缀芯片展示（不再「发送即消失」）
      const {
        display: visibleText,
        skillNames,
        mcpNames,
        connectorNames,
      } = userVisiblePromptText(text);
      // 专家：仅首次挂载或切换时贴气泡芯片（同专家后续消息不重复）
      const expertIdSnap =
        task.expertId?.trim() || get().draft?.expertId?.trim() || "";
      const prevAnnounced = task.lastAnnouncedExpertId?.trim() || "";
      let expertForBubble: ChatMessage["expert"];
      if (expertIdSnap && expertIdSnap !== prevAnnounced) {
        const { experts } = get();
        const expertHit = experts.find((e) => e.id === expertIdSnap);
        expertForBubble = {
          id: expertIdSnap,
          name: expertHit?.name?.trim() || expertIdSnap,
          emoji: expertHit?.emoji?.trim() || undefined,
        };
      }
      const nextAnnouncedExpertId = expertIdSnap || undefined;
      const userMsg: ChatMessage = {
        id: userMsgId,
        role: "user",
        createdAt: Date.now(),
        blocks: [{ type: "text", text: visibleText }],
        attachments: displayAttachments.length ? displayAttachments : undefined,
        taskReferences: taskReferences?.length ? taskReferences : undefined,
        terminalContext: terminalForBubble,
        selectionLabels: selectionLabelsForBubble.length
          ? selectionLabelsForBubble
          : undefined,
        skillCommands: skillNames.length ? skillNames : undefined,
        mcpNames: mcpNames.length ? mcpNames : undefined,
        connectorNames: connectorNames.length ? connectorNames : undefined,
        expert: expertForBubble,
      };
      const reply: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        createdAt: Date.now(),
        modelName: effectiveExternalAgent
          ? `${effectiveExternalAgent.name} · ACP`
          : models.find((m) => m.id === activeModelId)?.name,
        externalAgent: effectiveExternalAgent
          ? { ...effectiveExternalAgent }
          : undefined,
        blocks: [],
        finalBlocks: [],
        streaming: true,
        pendingBehavior: streamingBehavior,
      };

      const isFirstMessage = task.messages.length === 0;
      // P0 冻结：任务归属仅由 task.spaceId 决定，不吃 homeSpaceId。
      // 独立任务（spaceId=null/undefined）始终保持独立，已有对话不因首页选择器被误挂。
      const spaceId = task.spaceId ?? undefined;
      // P0：任务执行目录由主进程按 taskId 解析（canonical task root），
      // Renderer 不再从 space.path 推导 cwd，也不把 space path 写入 task.cwd。

      set((s) => ({
        tasks: s.tasks.map((x) =>
          x.id === activeTaskId
            ? {
                ...x,
                title: isFirstMessage
                  ? taskTitleFromFirstMessage(text)
                  : x.title,
                // 仅在任务尚无绑定时写入；已有 spaceId 或已有对话的独立任务不改
                spaceId: x.spaceId ?? spaceId,
                // 同步「已公告专家」：有专家则记下，无则清空（取消后再次引用可再贴）
                lastAnnouncedExpertId: nextAnnouncedExpertId,
                updatedAt: Date.now(),
                messages: isDurable ? x.messages : [...x.messages, userMsg, reply],
                ...(isDurable
                  ? {
                      botInputError: undefined,
                      botPendingSubmission: {
                        id: userMsgId,
                        text: visibleText,
                        attachmentNames: displayAttachments.map((a) => a.name),
                      },
                    }
                  : {}),
              }
            : x,
        ),
      }));

      let taskPersistence: Promise<unknown> | undefined;
      const updated = get().tasks.find((x) => x.id === activeTaskId);
      if (updated) {
        const persisted = storeContext.getApi()?.db?.upsertTask({
          id: updated.id,
          title: updated.title,
          spaceId: updated.spaceId,
          projectId: updated.projectId,
          status: updated.status,
          updatedAt: updated.updatedAt,
          sessionFile: updated.sessionFile,
          modelId: activeModelId,
          permissionMode,
          welcomeMode,
          expertId: updated.expertId,
          modePresetId: updated.modePresetId,
          // undefined → 保留 DB 值：发送途中的 unpin 不会被本次 upsert 盖回
          externalAgentPin: updated.externalAgentPin,
        });
        taskPersistence = persisted;
        if (materializedPlanId && persisted) {
          void persisted
            .then(async () => {
              const result = await storeContext.getApi()?.workgraph?.addEdge?.({
                fromType: "plan",
                fromId: materializedPlanId!,
                relation: "CONTAINS",
                toType: "task",
                toId: updated.id,
              });
              if (result && !result.ok)
                console.warn("[ProjectPlan] failed to link task", result.error);
            })
            .catch((cause) =>
              console.warn("[ProjectPlan] failed to persist/link task", cause),
            );
        }
      }

      const api = storeContext.getApi();
      if (effectiveExternalAgent) {
        const externalApi = api?.externalAgent;
        if (!externalApi) {
          get().applyAgentPatch({
            type: "assistant_end",
            taskId: activeTaskId,
            messageId: assistantMsgId,
            error:
              "（External Agent ACP API 未就绪，请完全退出并重启 MyBuddy）",
          });
          return;
        }
        void externalApi
          .prompt({
            taskId: activeTaskId,
            agentId: effectiveExternalAgent.id,
            text,
            displayText: visibleText,
            userMessageId: userMsgId,
            assistantMessageId: assistantMsgId,
            continueFromRunId: effectiveExternalAgent.continueFromRunId,
            attachments: atts
              .filter((a): a is Attachment & { path: string } =>
                Boolean(a.path),
              )
              .map((a) => ({ name: a.name, path: a.path })),
          })
          .then((result) => {
            set((state) => ({
              tasks: state.tasks.map((item) =>
                item.id !== activeTaskId
                  ? item
                  : {
                      ...item,
                      messages: item.messages.map((message) =>
                        message.id === assistantMsgId && message.externalAgent
                          ? {
                              ...message,
                              externalAgent: {
                                ...message.externalAgent,
                                runId: result.runId,
                              },
                            }
                          : message,
                      ),
                    },
              ),
            }));
          })
          .catch((err: unknown) => {
            get().applyAgentPatch({
              type: "assistant_end",
              taskId: activeTaskId,
              messageId: assistantMsgId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        return;
      }
      if (!api?.agent) {
        if (isDurable) {
          set((state) => ({
            tasks: state.tasks.map((item) =>
              item.id === activeTaskId
                ? {
                    ...item,
                    botInputError: "主进程 Agent API 未就绪",
                    botPendingSubmission: undefined,
                  }
                : item,
            ),
          }));
          return;
        }
        get().applyAgentPatch({
          type: "text_delta",
          taskId: activeTaskId,
          messageId: assistantMsgId,
          delta: "（主进程 Agent API 未就绪）",
          final: true,
        });
        get().applyAgentPatch({
          type: "assistant_end",
          taskId: activeTaskId,
          messageId: assistantMsgId,
        });
        return;
      }

      return Promise.resolve(taskPersistence)
        .then(() =>
          api.agent.prompt({
            taskId: activeTaskId,
            text,
            modelId: reqModelId,
            permissionMode: reqPermissionMode,
            welcomeMode,
            spaceId,
            sessionFile: task.sessionFile,
            assistantMessageId: assistantMsgId,
            userMessageId: userMsgId,
            streamingBehavior,
            expertId: task.expertId,
            attachments: atts
              .filter((a): a is Attachment & { path: string } =>
                Boolean(a.path),
              )
              .map((a) => ({ name: a.name, path: a.path })),
            selections: selectionRefs.length ? selectionRefs : undefined,
            terminalContext: terminalCtx ?? undefined,
            modePresetId: task.modePresetId,
            // 任务级 Active 连接器（与 task.connectorIds 同步；主进程据此装配私有技能并在变更时重建会话）
            connectorIds: connectorIds ?? task.connectorIds,
          }),
        )
        .then(async (result) => {
          // 主进程明确拒绝（如会话仍在生成但未指定 streamingBehavior）：给出用户可见错误，
          // 不静默吞掉。仅当本地确已插入空 assistant 壳时才以 error 结束它（诚实暴露失败）。
          if (result?.error) {
            if (isDurable) {
              set((state) => ({
                tasks: state.tasks.map((item) =>
                  item.id === activeTaskId
                    ? { ...item, botInputError: result.error!.message }
                    : item,
                ),
              }));
              return;
            }
            const currentTask = get().tasks.find(
              (item) => item.id === activeTaskId,
            );
            const replyStillStreaming = currentTask?.messages.some(
              (message) => message.id === assistantMsgId && message.streaming,
            );
            if (replyStillStreaming) {
              get().applyAgentPatch({
                type: "assistant_end",
                taskId: activeTaskId,
                messageId: assistantMsgId,
                error: result.error.message,
              });
            }
            return;
          }
          // 普通 prompt 的 Promise 在整轮结束后返回，可作为漏失 agent_end 的兜底；
          // steer/followUp 的 Promise 只表示“已入队”，绝不能据此结束 UI 流式态。
          // result 为空兼容热更新期间尚未重启的旧主进程；流式投递按 queued 处理更安全。
          const queued = result?.queued ?? Boolean(streamingBehavior);
          if (!isDurable && !queued) {
            const currentTask = get().tasks.find(
              (item) => item.id === activeTaskId,
            );
            const replyStillStreaming = currentTask?.messages.some(
              (message) => message.id === assistantMsgId && message.streaming,
            );
            if (replyStillStreaming) {
              get().applyAgentPatch({
                type: "assistant_end",
                taskId: activeTaskId,
                messageId: assistantMsgId,
              });
            }
          }
          // 同步主进程写入的 sessionFile / 权威 cwd（P0：主进程回读，Renderer 不决定目录）
          const rows = await api.db?.listTasks?.();
          const row = rows?.find((t) => t.id === activeTaskId);
          if (!row) return;
          set((s) => {
            // P1：以主进程落库的生效值回同步（重启后建议链/重启兜底可能改变任务实际模型/权限），
            // 保证 UI 显示值与真实 session 一致。
            // P3-1：守卫读取【目标任务自身】的 explicit flag（而非当前活跃任务 state）——
            // 轮次内切任务、目标任务被显式改选时不会被旧 row 回退；其它任务的显式状态不影响 T。
            return {
              tasks: s.tasks.map((t) =>
                t.id === activeTaskId
                  ? {
                      ...t,
                      sessionFile: row.sessionFile ?? t.sessionFile,
                      cwd: row.cwd ?? t.cwd,
                      ...(t.modelExplicit === true
                        ? {}
                        : { modelId: row.modelId ?? t.modelId }),
                      ...(t.permissionExplicit === true
                        ? {}
                        : {
                            permissionMode:
                              row.permissionMode ?? t.permissionMode,
                          }),
                    }
                  : t,
              ),
            };
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (isDurable) {
            set((state) => ({
              tasks: state.tasks.map((item) =>
                item.id === activeTaskId
                  ? { ...item, botInputError: message }
                  : item,
              ),
            }));
            return;
          }
          get().applyAgentPatch({
            type: "assistant_end",
            taskId: activeTaskId,
            messageId: assistantMsgId,
            error: message,
          });
        })
        .finally(() => {
          if (isDurable)
            set((state) => ({
              tasks: state.tasks.map((item) =>
                item.id === activeTaskId &&
                item.botPendingSubmission?.id === userMsgId
                  ? { ...item, botPendingSubmission: undefined }
                  : item,
              ),
            }));
        });
    },
  };
}
