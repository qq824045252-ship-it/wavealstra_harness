import { create } from "zustand";
import type { BtwStartRequest, BtwUiPatch, ChatMessageDto } from "../../../shared/agent-ipc";
import type { DurableBotSnapshot, DurableBotDelta, DurableBotState } from "../../../shared/durable-bot";
import { applyDurableDelta, replayDurableDeltas } from "../../../../shared/src/durable-sync";
import type { ChatMessage } from "@/types";
import { useAppStore } from "./appStore";
import { applyPatchToMessage } from "./app/messages/messageReducer";
import { historyMessageToChatMessage } from "./app/messages/historyMapper";

/**
 * BTW（By The Way，临时上下文分支）renderer 状态模型。
 *
 * 隔离契约（与主任务管道完全正交）：
 * - 消息只存在于本 store 的 ephemeral messages，绝不写入 Task.messages；
 * - 补丁只经独立 btw:event 通道进入 applyBtwPatch，绝不经过 applyAgentPatch 的任务 reducer；
 * - 消息/会话 id 使用 btw-* 前缀，与主任务 id 空间隔离；
 * - 执行记录由主进程持久保存；本地仅保存观察身份，重载后重新读取；
 * - 切换父任务结束观察；显式关闭才取消执行。
 */

let btwIdCounter = 0;
/** 随机段：保证多窗口（各自独立 counter）生成的 btwId 全局唯一，避免跨窗口会话碰撞 */
const btwRand = (): string => Math.random().toString(36).slice(2, 8);
const nextBtwId = (): string => `btw-${Date.now().toString(36)}-${btwIdCounter++}-${btwRand()}`;
const nextBtwMsgId = (kind: "u" | "a"): string =>
  `btw-${kind}-${Date.now().toString(36)}-${btwIdCounter++}-${btwRand()}`;

const btwObservationKey = (parentTaskId: string): string => `mybuddy.btw.observation:${parentTaskId}`;
function savedBtwObservation(parentTaskId: string): { request: BtwStartRequest; pending?: BtwPendingSend } | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(btwObservationKey(parentTaskId)) ?? "null");
    if (!value || typeof value !== "object" || !("btwId" in value) || typeof value.btwId !== "string" || !value.btwId.startsWith("btw-")
      || !("parentTaskId" in value) || value.parentTaskId !== parentTaskId) return undefined;
    const request: BtwStartRequest = { btwId: value.btwId, parentTaskId,
      ...("modelId" in value && typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
      ...("welcomeMode" in value && (value.welcomeMode === "working" || value.welcomeMode === "coding" || value.welcomeMode === "bot") ? { welcomeMode: value.welcomeMode } : {}) };
    const pending = "pending" in value ? value.pending : undefined;
    return { request, ...(pending && typeof pending === "object" && "text" in pending && typeof pending.text === "string"
      && "userMessageId" in pending && typeof pending.userMessageId === "string" && "assistantMessageId" in pending && typeof pending.assistantMessageId === "string"
      ? { pending: { text: pending.text, userMessageId: pending.userMessageId, assistantMessageId: pending.assistantMessageId } } : {}) };
  } catch { return undefined; }
}
function saveBtwObservation(request: BtwStartRequest, pending?: BtwPendingSend): void {
  try { localStorage.setItem(btwObservationKey(request.parentTaskId), JSON.stringify({ ...request, ...(pending ? { pending } : {}) })); } catch { /* Host execution still persists if browser storage is unavailable. */ }
}
let btwResync: { btwId: string; buffered: DurableBotDelta[] } | undefined;

function reattachBtw(request: BtwStartRequest): void {
  ensureBtwEventBridge(); startKeepalive();
  const generation = btwStartGeneration;
  void window.api?.btw?.start(request).then(() => {
    const state = useBtwStore.getState();
    if (generation !== btwStartGeneration || state.btwId !== request.btwId || !state.active) return;
    useBtwStore.setState({ ready: true, starting: false, pendingSend: null });
    if (state.pendingSend) promptBtwTurn(request.btwId, state.pendingSend.text, state.pendingSend.userMessageId, state.pendingSend.assistantMessageId);
  }).catch((error: unknown) => {
    if (generation !== btwStartGeneration || useBtwStore.getState().btwId !== request.btwId) return;
    btwResync = undefined;
    useBtwStore.setState({ starting: false, ready: false, error: `BTW 同步失败：${error instanceof Error ? error.message : String(error)}` });
  });
}

/** 带回主线的结论长度上限：填 Composer 的是精简结论，不是整段历史 */
const BRING_BACK_ANSWER_MAX_CHARS = 1000;
const BRING_BACK_QUESTION_MAX_CHARS = 200;

/**
 * BTW 发送路由（纯函数）：BTW 激活时只消费独立草稿 btwText，绝不读取/清空主 composer text。
 * 返回 null 表示无内容可发（空文本）；调用方应只清空 btwText。
 * 抽成纯函数是为了让 ChatInput 的发送路径可被行为测试 + 架构断言双重保护，
 * 防止再次出现“textarea 用 btwText，但 send() 用 text”的回归。
 */
export function btwComposerSendInput(btwActive: boolean, btwText: string): string | null {
  if (!btwActive) return null;
  const trimmed = btwText?.trim() ?? "";
  return trimmed ? trimmed : null;
}

/**
 * BTW 生成超时（ms）：streaming 超过该时长没有任何补丁/终态到达时，
 * renderer 重新读取持久状态，观察超时不取消后台执行。
 */
export const BTW_STREAMING_TIMEOUT_MS = 10 * 60_000;

/** 纯函数：streaming 是否已超时滞留（供 keepalive 心跳调用 + 单测） */
export function isStreamingStalled(
  streaming: boolean,
  streamingSince: number | null,
  now: number,
  timeoutMs: number = BTW_STREAMING_TIMEOUT_MS,
): boolean {
  return Boolean(streaming && streamingSince !== null && now - streamingSince > timeoutMs);
}

interface BtwPendingSend {
  text: string;
  userMessageId: string;
  assistantMessageId: string;
}

/**
 * 发送一轮 BTW prompt 并处理异步终态（统一入口，start 排队补发复用）：
 * - 会话身份守卫：late reject 不允许写入已关闭/已切换的会话；
 * - start IPC 在途导致的首次失败：排队（pendingSend），start 完成后自动补发，
 *   用户无需手动重发、不丢输入；
 * - start 已完成但 prompt 调用恰逢会话建立瞬间失败：重试一次；
 * - 其余失败：settle 本条消息（streaming=false），不悬挂。
 */
function promptBtwTurn(
  btwId: string,
  text: string,
  userMessageId: string,
  assistantMessageId: string,
  attempt = 0,
): void {
  const observation = useBtwStore.getState();
  const pendingSend = { text, userMessageId, assistantMessageId };
  if (observation.btwId === btwId && observation.startRequest) {
    useBtwStore.setState({ pendingSend });
    saveBtwObservation(observation.startRequest, pendingSend);
  }
  void window.api?.btw
    ?.prompt({ btwId, text, userMessageId, assistantMessageId })
    .then(() => {
      const state = useBtwStore.getState();
      if (state.btwId !== btwId || state.pendingSend?.userMessageId !== userMessageId || !state.startRequest) return;
      useBtwStore.setState({ pendingSend: null });
      saveBtwObservation(state.startRequest);
    })
    .catch((err: unknown) => {
      const now = useBtwStore.getState();
      // 会话身份守卫：若已 close 或已切换到新 BTW（btwId 变化），本次失败与当前会话无关
      if (!now.active || now.btwId !== btwId) return;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && now.starting) {
        // start IPC 仍在途（会话尚未建成导致本次失败）：排队，start.then 自动补发
        useBtwStore.setState({ pendingSend: { text, userMessageId, assistantMessageId } });
        return;
      }
      if (attempt === 0 && now.ready) {
        // start 已完成但本次 prompt 恰逢会话建立瞬间失败：重试一次
        promptBtwTurn(btwId, text, userMessageId, assistantMessageId, 1);
        return;
      }
      // 正常失败终态：settle 本条消息，不悬挂 streaming
      useBtwStore.setState((s) => {
        if (!s.active || s.btwId !== btwId) return s;
        return {
          streaming: s.messages.some((m) => m.id === assistantMessageId && m.streaming)
            ? false
            : s.streaming,
          streamingSince: null,
          messages: s.messages.map((m) =>
            m.id === assistantMessageId && m.streaming ? { ...m, streaming: false } : m,
          ),
          error: message,
        };
      });
    });
}

/** Observation timeout requests a fresh snapshot; it never cancels execution. */
function settleStalledStream(btwId: string): void {
  const state = useBtwStore.getState();
  if (!state.active || state.btwId !== btwId || !state.startRequest) return;
  useBtwStore.setState({ streamingSince: Date.now(), notice: "正在重新同步 BTW 进度…" });
  reattachBtw(state.startRequest);
}

function textOf(msg: ChatMessage, onlyFinal: boolean): string {
  const blocks = onlyFinal ? msg.finalBlocks ?? [] : msg.blocks ?? [];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

/**
 * 带回主线：整理「最后问题 + 最后一条已完成的有效回答」的精简结论。
 * - 跳过仍在生成（streaming）的轮次；
 * - 优先 finalBlocks 最终答复，回退过程 blocks（如中止轮只有过程文本）；
 * - 答案截断到 BRING_BACK_ANSWER_MAX_CHARS，避免整段历史灌进主 Composer。
 * 后续如切换成真正 LLM summarization，只替换本函数即可。
 */
function summarizeForMain(
  messages: ChatMessage[],
): { question: string; answer: string; questionMessageId: string | null } | null {
  let answerIndex = -1;
  let answer = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "assistant" || m.streaming) continue;
    const finalText = textOf(m, true);
    if (finalText) {
      answer = finalText;
      answerIndex = i;
      break;
    }
    const bodyText = textOf(m, false);
    if (bodyText) {
      answer = bodyText;
      answerIndex = i;
      break;
    }
  }
  if (answerIndex < 0 || !answer) return null;
  let question = "";
  let questionMessageId: string | null = null;
  for (let i = answerIndex - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "user") continue;
    question = textOf(m, false);
    if (question) {
      questionMessageId = m.id;
      break;
    }
  }
  return {
    question: truncate(question, BRING_BACK_QUESTION_MAX_CHARS),
    answer: truncate(answer, BRING_BACK_ANSWER_MAX_CHARS),
    questionMessageId,
  };
}

let btwEventUnsub: (() => void) | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
/**
 * BTW start 代际计数：start IPC 在途期间用户可能已 close / 再次 start。
 * 每次 start/close 递增；在途 promise 完成时比对代际，避免旧异步回调
 * 复活已关闭的 BTW 或把错误写进新会话。
 */
let btwStartGeneration = 0;

/** 挂载 btw:event 订阅（StrictMode/HMR 幂等） */
function ensureBtwEventBridge(): void {
  if (btwEventUnsub) return;
  btwEventUnsub =
    window.api?.btw?.onEvent?.((patch) => {
      useBtwStore.getState().applyBtwPatch(patch);
    }) ?? null;
}

/** 心跳：主进程据此回收 renderer 重载后遗留的孤儿 BTW 会话；顺带做 streaming 超时兜底 */
function startKeepalive(): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    const st = useBtwStore.getState();
    if (!st.active || !st.btwId) {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = null;
      return;
    }
    void window.api?.btw?.keepalive?.([st.btwId]).catch(() => undefined);
    // 生成超时兜底：长时间无任何补丁/终态时本地 settle，防止会话永久卡 streaming
    if (st.streaming && isStreamingStalled(st.streaming, st.streamingSince, Date.now())) {
      settleStalledStream(st.btwId);
    }
  }, 5_000);
}

interface BtwState {
  /** BTW 是否处于激活态（状态条/占位符/按钮高亮） */
  active: boolean;
  /** 面板是否折叠（折叠不中断生成） */
  collapsed: boolean;
  /** 是否已发出第一轮（面板在首轮发送后出现） */
  started: boolean;
  /** start IPC 是否仍在途（会话尚未就绪） */
  starting: boolean;
  /** start 是否已成功完成、会话可用 */
  ready: boolean;
  /** start 在途时首轮发送的排队载荷（start 完成后自动补发） */
  pendingSend: BtwPendingSend | null;
  /** 最近一次 streaming 开始时刻（超时兜底用） */
  streamingSince: number | null;
  /** 已带回主线的最后一轮用户消息 id（幂等去重） */
  lastBringBackUserMsgId: string | null;
  btwId: string | null;
  /** 观察所属的主任务 id；切换后按原身份重附着。 */
  parentTaskId: string | null;
  startRequest: BtwStartRequest | null;
  durable?: DurableBotSnapshot;
  /** 快照时刻（点击 BTW 的瞬间） */
  snapshotAt: number;
  /** BTW 自己的临时消息集合（绝不写入 Task.messages） */
  messages: ChatMessage[];
  /** 是否有消息仍在生成（BTW 自身；与主任务 executing 完全独立） */
  streaming: boolean;
  /** 面板内错误提示（不打扰主对话） */
  error: string | null;
  /** 带回主线等操作的轻提示 */
  notice: string | null;

  start: () => void;
  send: (text: string) => void;
  abort: () => void;
  /** 关闭即销毁（正在生成时先中止 BTW 自己的 runtime） */
  close: () => void;
  toggleCollapsed: () => void;
  expand: () => void;
  /** 主动作：把结论填入主 Composer（不自动发送；BTW 保留至用户关闭） */
  bringBackToComposer: () => void;
  /** 只消费 btw:event 通道的补丁；btwId 不匹配一律丢弃 */
  applyBtwPatch: (patch: BtwUiPatch) => void;
  /** 父任务切换时停止观察，进入其他任务时恢复其已有观察。 */
  destroyIfParentChanged: (activeTaskId: string | null) => void;
}

export const useBtwStore = create<BtwState>((set, get) => ({
  active: false,
  collapsed: false,
  started: false,
  starting: false,
  ready: false,
  pendingSend: null,
  streamingSince: null,
  lastBringBackUserMsgId: null,
  btwId: null,
  parentTaskId: null,
  startRequest: null,
  snapshotAt: 0,
  messages: [],
  streaming: false,
  error: null,
  notice: null,

  start: () => {
    const app = useAppStore.getState();
    const task = app.tasks.find((t) => t.id === app.activeTaskId);
    // 无主对话上下文时不进入 BTW（home/空任务不强行 materialize 正式 Task）
    if (!task || (task.messages.length === 0 && !task.sessionFile)) return;
    if (get().active) return;
    const btwId = nextBtwId();
    const startRequest: BtwStartRequest = { btwId, parentTaskId: task.id, modelId: app.activeModelId, welcomeMode: task.welcomeMode ?? app.welcomeMode };
    saveBtwObservation(startRequest);
    const gen = ++btwStartGeneration;
    set({
      active: true,
      collapsed: false,
      started: false,
      starting: true,
      ready: false,
      pendingSend: null,
      streamingSince: null,
      lastBringBackUserMsgId: null,
      btwId,
      parentTaskId: task.id,
      startRequest,
      durable: undefined,
      snapshotAt: Date.now(),
      messages: [],
      streaming: false,
      error: null,
      notice: null,
    });
    ensureBtwEventBridge();
    startKeepalive();
    void window.api?.btw
      ?.start({
        btwId,
        parentTaskId: task.id,
        modelId: app.activeModelId,
        welcomeMode: task.welcomeMode ?? app.welcomeMode,
      })
      .then(() => {
        // A stale observer cannot reacquire a closed or switched view.
        const st = get();
        if (gen !== btwStartGeneration || !st.active || st.btwId !== btwId) {
          return;
        }
        // 会话就绪：若首轮发送已排队（start 在途时用户发送），自动补发（同一对消息 id，UI 无感）
        const pending = st.pendingSend;
        set({ starting: false, ready: true, pendingSend: null });
        if (pending) {
          promptBtwTurn(btwId, pending.text, pending.userMessageId, pending.assistantMessageId);
        }
      })
      .catch((err: unknown) => {
        if (gen !== btwStartGeneration) return; // 已被更新的 start/close 取代
        const message = err instanceof Error ? err.message : String(err);
        set((s) => {
          const pending = s.pendingSend;
          if (!pending) {
            return { starting: false, ready: false, error: `BTW 启动失败：${message}` };
          }
          // start 失败且首轮已排队：settle 该消息，避免卡 streaming
          return {
            starting: false,
            ready: false,
            pendingSend: null,
            streaming: false,
            streamingSince: null,
            messages: s.messages.map((m) =>
              m.id === pending.assistantMessageId && m.streaming ? { ...m, streaming: false } : m,
            ),
            error: `BTW 启动失败：${message}（首轮未发送）`,
          };
        });
      });
  },

  send: (text) => {
    const st = get();
    const trimmed = text?.trim() ?? "";
    if (!st.active || !st.btwId || !trimmed) return;
    if (st.streaming) return; // BTW 自身单轮串行；与主任务并发互不影响
    // 捕获发送时的会话身份：prompt 异步终态（reject）只允许写回同一会话
    const sessionBtwId = st.btwId;
    const userMsgId = nextBtwMsgId("u");
    const asstMsgId = nextBtwMsgId("a");
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: "user",
      createdAt: Date.now(),
      blocks: [{ type: "text", text: trimmed }],
    };
    const reply: ChatMessage = {
      id: asstMsgId,
      role: "assistant",
      createdAt: Date.now(),
      modelName: undefined,
      blocks: [],
      finalBlocks: [],
      streaming: true,
    };
    set({
      messages: [...st.messages, userMsg, reply],
      streaming: true,
      streamingSince: Date.now(),
      error: null,
      started: true,
      collapsed: false,
    });
    // 统一发送入口：start 在途时首次失败会自动排队，start 完成后补发
    promptBtwTurn(sessionBtwId, trimmed, userMsgId, asstMsgId);
  },

  abort: () => {
    const st = get();
    if (!st.active || !st.btwId || !st.streaming) return;
    void window.api?.btw?.abort?.(st.btwId).catch(() => undefined);
  },

  close: () => {
    const st = get();
    if (!st.active || !st.btwId) return;
    const btwId = st.btwId;
    if (st.parentTaskId) { try { localStorage.removeItem(btwObservationKey(st.parentTaskId)); } catch { /* Optional browser persistence. */ } }
    btwResync = undefined;
    // 使在途 start 回调失效（其 then 分支会补发 close 清理主进程会话）
    btwStartGeneration += 1;
    // 先清本地状态（UI 立即退出），再通知主进程 abort+dispose；不等待主进程完成
    set({
      active: false,
      collapsed: false,
      started: false,
      starting: false,
      ready: false,
      pendingSend: null,
      streamingSince: null,
      lastBringBackUserMsgId: null,
      btwId: null,
      parentTaskId: null,
      startRequest: null,
      durable: undefined,
      snapshotAt: 0,
      messages: [],
      streaming: false,
      error: null,
      notice: null,
    });
    void window.api?.btw?.close?.(btwId).catch(() => undefined);
  },

  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),

  expand: () => set({ collapsed: false }),

  bringBackToComposer: () => {
    const st = get();
    if (!st.active || st.messages.length === 0) return;
    const summary = summarizeForMain(st.messages);
    if (!summary) {
      set({ notice: "BTW 暂无已完成回答，请等待生成完成后重试" });
      return;
    }
    // 幂等去重：同一轮结论只带回一次；新一轮问答完成后可再次带回新结论
    if (
      summary.questionMessageId !== null &&
      st.lastBringBackUserMsgId === summary.questionMessageId
    ) {
      set({ notice: "该轮结论已带回主输入框（新一轮问答后可再次带回）" });
      return;
    }
    // 明确来源前缀 + 问题/结论两段；只填 Composer，绝不直接写主 Task.messages
    const draft =
      `【BTW 结论】${summary.question ? `\n问：${summary.question}` : ""}\n答：${summary.answer}`.trim();
    // 安全追加：绝不清空用户已有的主线草稿——存在时用分隔线追加在末尾
    const existing = useAppStore.getState().composerDraft?.trim();
    const finalDraft = existing ? `${existing}\n\n---\n${draft}` : draft;
    useAppStore.getState().fillComposer(finalDraft);
    set({
      notice: "已把 BTW 精简结论追加到主输入框（可编辑后发送）",
      lastBringBackUserMsgId: summary.questionMessageId,
    });
  },

  applyBtwPatch: (patch) => {
    const current = get();
    if (!current.active || !current.btwId || patch.btwId !== current.btwId) return;
    if (patch.type === "durable_delta") {
      if (btwResync?.btwId === patch.btwId) { btwResync.buffered.push(patch.delta); if (btwResync.buffered.length > 256) btwResync.buffered.shift(); return; }
      const result = applyDurableDelta<ChatMessageDto, DurableBotState>(current.durable, patch.delta);
      if (result.kind === "applied") get().applyBtwPatch({ type: "durable_snapshot", taskId: patch.taskId, btwId: patch.btwId, snapshot: result.snapshot });
      else if (result.kind === "resync" && current.startRequest) {
        btwResync = { btwId: patch.btwId, buffered: [patch.delta] };
        reattachBtw(current.startRequest);
      }
      return;
    }
    set((s) => {
      if (!s.active || !s.btwId || patch.btwId !== s.btwId) return s;
      if (patch.type === "durable_snapshot") {
        if (s.durable?.epoch === patch.snapshot.epoch && s.durable.revision >= patch.snapshot.revision) return s;
        const previous = new Map(s.durable?.messages.map(message => [message.id, message]));
        const displayed = new Map(s.messages.map(message => [message.id, message]));
        return { ...s, durable: patch.snapshot, started: s.started || patch.snapshot.messages.length > 0,
          messages: patch.snapshot.messages.map(message => {
            const prior = displayed.get(message.id);
            return prior && previous.get(message.id) === message ? prior : { ...historyMessageToChatMessage(message), streaming: message.streaming,
              presentationKey: message.presentationKey, generationStats: message.generationStats };
          }), streaming: patch.snapshot.busy,
          streamingSince: patch.snapshot.busy ? s.streamingSince ?? Date.now() : null, error: patch.snapshot.error ?? null };
      }
      if (!("messageId" in patch) || !patch.messageId) return s;
      const { messageId } = patch;
      let messages = s.messages;
      const hasMsg = messages.some((m) => m.id === messageId);
      if (!hasMsg) {
        const shell: ChatMessage = {
          id: messageId,
          role: "assistant",
          blocks: [],
          createdAt: Date.now(),
          streaming: patch.type !== "assistant_end",
        };
        messages = [...messages, shell];
      }
      messages = messages.map((m) => (m.id === messageId ? applyPatchToMessage(m, patch) : m));
      const streaming = messages.some((m) => m.streaming);
      const error =
        patch.type === "assistant_end" && patch.error ? patch.error : s.error;
      // 维护超时兜底计时：streaming 结束时清除起点，开始时（如 shell 消息）补设
      return {
        ...s,
        messages,
        streaming,
        streamingSince: streaming ? (s.streamingSince ?? Date.now()) : null,
        error,
      };
    });
    if (patch.type === "durable_snapshot" && btwResync?.btwId === patch.btwId) {
      const pending = btwResync.buffered; btwResync = undefined;
      const accepted = get().durable;
      if (accepted) {
        const replay = replayDurableDeltas<ChatMessageDto, DurableBotState>(accepted, pending);
        get().applyBtwPatch({ type: "durable_snapshot", taskId: patch.taskId, btwId: patch.btwId, snapshot: replay.snapshot });
        if (replay.gap) set({ error: "BTW 增量仍有缺口，请重新打开会话" });
      }
    }
  },

  destroyIfParentChanged: (activeTaskId) => {
    const st = get();
    if (st.active && st.parentTaskId !== null && st.parentTaskId !== activeTaskId) {
      btwStartGeneration++;
      btwResync = undefined;
      set({ active: false, ready: false, starting: false, btwId: null, parentTaskId: null, startRequest: null, durable: undefined, messages: [], streaming: false, streamingSince: null, pendingSend: null });
    }
    if (!get().active && activeTaskId) {
      const saved = savedBtwObservation(activeTaskId);
      if (!saved) return;
      const { request } = saved;
      btwStartGeneration++;
      set({ active: true, starting: true, ready: false, started: true, collapsed: false, btwId: request.btwId, parentTaskId: request.parentTaskId,
        startRequest: request, pendingSend: saved.pending ?? null, durable: undefined, snapshotAt: Date.now(), messages: [], streaming: false, error: null, notice: null, lastBringBackUserMsgId: null });
      reattachBtw(request);
    }
  },
}));
