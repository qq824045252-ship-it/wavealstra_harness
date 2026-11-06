import type { ModeProfileDto } from "../../../../../shared/agent-ipc";
import { defaultModePresetId } from "../../../../../shared/mode-profile";
import { loadTaskAsRefItem } from "../../../lib/loadRefTask";
import { collectTaskDomainArtifacts } from "../../../lib/refTaskArtifacts";
import type { RefFileItem } from "../../../lib/refTaskArtifacts";
import {
  buildRelatedTaskPrompt,
  resolveRelatedTaskSpec,
} from "../../../lib/relatedTask";
import type { RefTaskItem } from "../../../lib/taskReference";
import type { Expert, Task, TaskReference } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { uid } from "../runtime/ids";

export function createRelatedTasksActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  "shareTaskToConversation" | "duplicateTaskWithMode" | "createRelatedTask"
> {
  const { get, set } = storeContext;
  return {
    shareTaskToConversation: async (sourceTaskId, targetTaskId) => {
      if (!sourceTaskId || !targetTaskId || sourceTaskId === targetTaskId)
        return false;
      const state = get();
      const source = state.tasks.find((t) => t.id === sourceTaskId);
      const target = state.tasks.find((t) => t.id === targetTaskId);
      if (!source || !target || target.archived) return false;

      let ref: RefTaskItem;
      try {
        ref = await loadTaskAsRefItem({
          task: source,
          spaces: state.spaces,
          artifactDomain: storeContext.getApi()?.artifactDomain,
          loadHistory: storeContext.getApi()?.agent?.loadTaskHistory
            ? (id) => storeContext.getApi()!.agent!.loadTaskHistory!(id)
            : undefined,
        });
      } catch (err) {
        console.warn("[shareTaskToConversation] load source failed", err);
        return false;
      }

      // 先切到目标任务（会清掉跨任务 pending），再挂起本次分享引用
      get().setActiveTask(targetTaskId);
      set((s) => ({
        pendingRefTask: ref,
        chatFocusTick: s.chatFocusTick + 1,
        page: "chat",
      }));
      return true;
    },

    duplicateTaskWithMode: (mode, fromTaskId) => {
      const state = get();
      const sourceId = fromTaskId ?? state.activeTaskId;
      const source = sourceId
        ? state.tasks.find((t) => t.id === sourceId)
        : undefined;
      const task: Task = {
        id: uid(storeContext),
        title: source?.title
          ? `${source.title}（${mode === "working" ? "办公" : mode === "bot" ? "Bot" : "编码"}）`
          : "新任务",
        spaceId: source?.spaceId,
        projectId: source?.projectId,
        updatedAt: Date.now(),
        messages: [],
        modelId: source?.modelId ?? state.activeModelId,
        permissionMode: source?.permissionMode ?? state.permissionMode,
        welcomeMode: mode,
        cwd: source?.cwd,
        // 不复制 sessionFile / expertId（干净新会话；专家可再召唤）
        // preset：复制到当前模式带当前 selection；复制到其它模式用该模式默认（集中式，保证合法）
        modePresetId:
          mode === state.welcomeMode
            ? (state.modePresetId ?? defaultModePresetId(mode))
            : defaultModePresetId(mode),
      };
      set((s) => ({
        tasks: [task, ...s.tasks],
        activeTaskId: task.id,
        welcomeMode: mode,
        homeSpaceId: source?.spaceId ?? s.homeSpaceId,
        page: "chat",
        panelOpen: false,
        chatSelections: [],
        artifactTabs: [],
        activeArtifactId: null,
      }));
      void get().hydrateArtifacts(task.id);
    },

    createRelatedTask: async (opts) => {
      const state = get();
      const source = state.tasks.find((t) => t.id === opts.sourceTaskId);
      if (!source) return null;

      // 1) 目标专家：未安装 → 尝试市场安装（复用现有安装链路）；仍不可得 → 返回 null（调用方引导，不静默失败）
      let expertId = opts.expertId ?? undefined;
      if (expertId) {
        const has = (list: Expert[]): boolean =>
          list.some((e) => e.id === expertId || e.name === expertId);
        if (!has(get().experts)) {
          try {
            await storeContext.getApi()?.agent?.installExpert?.(expertId);
            await get().refreshExperts();
          } catch (err) {
            console.warn("[createRelatedTask] expert install failed", err);
          }
          if (!has(get().experts)) return null;
        }
      }

      // 2) 目标模式 profile → 统一策略解析（显式 > Tag 建议 > 回退链）
      let profile: ModeProfileDto | null = null;
      try {
        profile =
          (await storeContext
            .getApi()
            ?.agent?.getModeProfile?.(opts.welcomeMode)) ?? null;
      } catch {
        profile = null;
      }
      const isModelAvailable = (id: string): boolean =>
        get().models.some((m) => m.id === id || `${m.vendor}/${m.id}` === id);
      const spec = resolveRelatedTaskSpec({
        sourceTitle: source.title,
        welcomeMode: opts.welcomeMode,
        modePresetId: opts.modePresetId,
        expertId,
        permissionMode: opts.permissionMode,
        modelId: opts.modelId,
        fallbackPermission: state.permissionMode,
        fallbackModelId: source.modelId ?? state.activeModelId,
        instruction: opts.instruction,
        isModelAvailable,
        profile,
      });

      // 3) 源任务上下文（对话 + 文件，复用 InputAddMenu 同一套 refTask 数据装配）
      const space =
        state.spaces.find((s) => s.id === source.spaceId) ?? undefined;
      let messages = source.messages
        .map((m) => ({
          role: m.role as "user" | "assistant",
          text: [...m.blocks, ...(m.finalBlocks ?? [])]
            .filter(
              (b): b is { type: "text"; text: string } => b.type === "text",
            )
            .map((b) => b.text)
            .join("\n")
            .trim(),
        }))
        .filter((m) => m.text);
      const files: RefFileItem[] = [];
      if (source.sessionFile) {
        try {
          const history = await storeContext
            .getApi()
            ?.agent?.loadTaskHistory?.(source.id);
          if (history && messages.length === 0) {
            messages = (history.messages ?? [])
              .map((m) => ({ role: m.role, text: m.text.trim() }))
              .filter((m) => m.text);
          }
          const seen = new Set<string>();
          const push = (item: RefFileItem): void => {
            const key = (item.path || item.name || item.id).toLowerCase();
            if (!key || seen.has(key)) return;
            seen.add(key);
            files.push(item);
          };
          for (const item of await collectTaskDomainArtifacts(
            storeContext.getApi()?.artifactDomain,
            source.id,
          )) {
            push(item);
          }
          for (const m of history?.messages ?? []) {
            for (const a of m.artifacts ?? []) {
              push({
                id: a.id,
                name: a.name,
                path: a.path,
                content: a.path ? undefined : a.content || undefined,
                source: "artifact",
              });
            }
            for (const a of m.attachments ?? []) {
              push({
                id: `att:${a.path || a.name}`,
                name: a.name,
                path: a.path,
                source: "attachment",
              });
            }
          }
        } catch (err) {
          console.warn(
            "[createRelatedTask] load source task history failed",
            err,
          );
        }
      }
      const promptText = buildRelatedTaskPrompt(spec.instruction, {
        title: source.title,
        spaceName: space?.name,
        cwd: source.cwd ?? space?.path,
        messages,
        files,
      });

      // 4) 创建独立任务（同 Space；独立 session 由首条 prompt 创建）并激活
      const task: Task = {
        id: uid(storeContext),
        title: opts.title ?? spec.title,
        spaceId: source.spaceId,
        projectId: source.projectId,
        updatedAt: Date.now(),
        messages: [],
        modelId: spec.modelId,
        permissionMode: spec.permissionMode,
        welcomeMode: spec.welcomeMode,
        expertId: spec.expertId ?? undefined,
        modePresetId: spec.modePresetId,
      };
      set((s) => ({
        tasks: [task, ...s.tasks],
        activeTaskId: task.id,
        draft: null,
        welcomeMode: spec.welcomeMode,
        modePresetId: spec.modePresetId,
        activeModelId: spec.modelId ?? s.activeModelId,
        permissionMode: spec.permissionMode,
        fullAccessDuringRun: spec.permissionMode === "auto",
        // 关联任务从零开始：不继承源任务/上一任务的 Active 连接器（安装 ≠ active）
        activeConnectorIds: [],
        // F2：关联任务按「显式 > Tag > fallback」解析注入首条消息，但任务本身不置 explicit：
        // 首条消息后任务已有会话 → 后续消息沿用该任务上次生效值（重启兜底语义，与普通已有任务一致）；
        // 需要切换到当前 Tag/Mode 建议时使用「跟随场景建议」。
        modelExplicit: false,
        permissionExplicit: false,
        homeSpaceId: source.spaceId ?? s.homeSpaceId,
        page: "chat",
        panelOpen: false,
        chatSelections: [],
        artifactTabs: [],
        activeArtifactId: null,
      }));
      void get().hydrateArtifacts(task.id);
      void storeContext.getApi()?.db?.upsertTask({
        id: task.id,
        title: task.title,
        spaceId: task.spaceId,
        projectId: task.projectId,
        updatedAt: task.updatedAt,
        modelId: task.modelId,
        permissionMode: task.permissionMode,
        welcomeMode: task.welcomeMode,
        expertId: task.expertId,
        modePresetId: task.modePresetId,
      });

      // 5) 发送首条消息（引用源任务；独立 session 由此建立，模式/权限/专家由主进程按 task 字段装配）
      const taskRefs: TaskReference[] = [
        {
          taskId: source.id,
          title: source.title,
          spaceName: space?.name,
          files: files.map((f) => ({
            id: f.id,
            name: f.name,
            path: f.path,
            source: f.source,
          })),
        },
      ];
      get().sendMessage(promptText, undefined, taskRefs, undefined, undefined, {
        // 已解析场景（显式 > Tag 建议 > 回退链）直接作为 explicit 注入，与主进程解析等价
        modelId: spec.modelId,
        permissionMode: spec.permissionMode,
      });
      return task.id;
    },
  };
}
