import { DEFAULT_WELCOME_MODE } from "@shared/mode-profile";
import TaskRecoveryNotice from "./TaskRecoveryNotice";
import SessionHistoryRecoveryNotice from "./SessionHistoryRecoveryNotice";
import TaskModelRecoveryNotice from "./TaskModelRecoveryNotice";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useActiveTask, useActiveTaskArtifacts, useVisibleTaskArtifacts, useAppStore } from "@/store/appStore";
import type { Artifact, ChatMessage, Space } from "@/types";
import { heroCategories } from "@/mock/data";
import MessageItem from "./MessageItem";
import { durableMessageToChatMessage } from "@/store/app/messages/historyMapper";
import { botMessagePresentation } from "@/lib/botMessagePresentation";
import ChatInput from "./ChatInput";
import ConversationGoalChip from "./ConversationGoalChip";
import ConversationBranchChip from "./ConversationBranchChip";
import ChatProjectCrumb from "./ChatProjectCrumb";
import WorkspaceCrumb from "./WorkspaceCrumb";
import RuntimeStatusChips from "./RuntimeStatusChips";
import TaskWriteGrantsMenu from "./TaskWriteGrantsMenu";
import TaskDiagnosticsDialog from "./TaskDiagnosticsDialog";
import WelcomeModeIcon from "@/components/common/WelcomeModeIcon";
import {
  IconChevronDown,
  IconClock,
  IconAlert,
  IconMore,
  IconPanel,
  IconX,
} from "@/components/common/icons";
import type { McpServerDto, ModePresetDto, WelcomeMode } from "@shared/agent-ipc";
import { WELCOME_MODE_LABELS } from "@shared/mode-profile";
import { buildPresetBarChips, isTaskModeLocked } from "@/lib/modePresetBar";
import { COPY, getWorkspaceBreadcrumb } from "@/lib/workspaceDisplay";
import { heroHeadline, heroSubline } from "./heroCopy";
import HeroSuggestChips from "./HeroSuggestChips";
import {
  initialFollowState,
  keyboardIntent,
  onHistoryJump,
  onPointerCancel,
  onPointerDown,
  onPointerUp,
  onResetForTask,
  onScroll as onFollowScroll,
  onUserScrollDown,
  onUserScrollUp,
  onWheelUpCandidate,
  shouldAdjustScrollCompensation,
  shouldInferUserScroll,
  shouldPinOnNewTurn,
  type FollowState,
} from "@/lib/scrollFollow";
import { isPrependOnly, mergeHistoryWindow } from "@/lib/historyWindow";
import { useEarlierHistory } from "./useEarlierHistory";
import { estimateMessageHeight } from "@/lib/messageSizeEstimate";

/** 中等长度的历史已经可能包含巨大的工具/Markdown 内容，应尽早虚拟化。 */
const MESSAGE_VIRTUALIZE_THRESHOLD = 16;
/** 新一轮用户消息置顶时距滚动容器顶的留白 */
const TURN_TOP_OFFSET = 8;

/**
 * shouldAdjustScrollPositionOnItemSizeChange 是 virtual-core 选项但 React 包装层
 * 类型未暴露（v3.14.9）；用断言补类型（运行时选项有效）。
 */
type VirtualizerOptionsWithCompensation = Parameters<typeof useVirtualizer>[0] & {
  shouldAdjustScrollPositionOnItemSizeChange: (
    item: VirtualItem,
    delta: number,
    instance: Virtualizer<HTMLDivElement, Element>,
  ) => boolean;
};

function recentSpaceLabel(spaces: Space[], spaceId: string | undefined): string {
  if (!spaceId) return COPY.independentTask;
  const chain = getWorkspaceBreadcrumb(spaces, spaceId);
  if (chain.length === 0) return COPY.workspace;
  const leaf = chain[chain.length - 1];
  if (leaf && /^\d{8}[_-]/.test(leaf.name) && chain.length > 1) return chain[0].name;
  return leaf?.name ?? COPY.workspace;
}

function formatRecentTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`;
  if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.max(1, Math.floor(delta / 86_400_000))} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function HomeHero(): React.JSX.Element {
  const welcomeMode = useAppStore((s) => s.welcomeMode);
  const setWelcomeMode = useAppStore((s) => s.setWelcomeMode);
  const modePresetId = useAppStore((s) => s.modePresetId);
  const setModePreset = useAppStore((s) => s.setModePreset);
  const fillComposer = useAppStore((s) => s.fillComposer);
  const setActiveTask = useAppStore((s) => s.setActiveTask);
  const tasks = useAppStore((s) => s.tasks);
  const spaces = useAppStore((s) => s.spaces);
  const task = useActiveTask();
  const [presets, setPresets] = useState<ModePresetDto[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerDto[]>([]);
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const recentTasks = useMemo(
    () =>
      tasks
        .filter((item) => !item.archived && ((item.messages?.length ?? 0) > 0 || Boolean(item.sessionFile)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3),
    [tasks],
  );

  const categoryToMode: Record<string, WelcomeMode> = {
    日常办公: "working",
    代码开发: "coding",
    Bot: "bot",
  };
  const modeToCategory: Record<string, string> = {
    working: "日常办公",
    coding: "代码开发",
    bot: "Bot",
  };
  const category = modeToCategory[welcomeMode] ?? heroCategories[0];

  useEffect(() => {
    void window.api?.agent?.getModeProfile?.(welcomeMode).then((p) => {
      setPresets(p?.policy?.presets ?? []);
    });
  }, [welcomeMode]);

  // Preset Bar 可用性：仅当 preset 声明了 providerMcpIds 才需要查 MCP（复用现有 mcp:listServers）
  const needsProviderCheck = presets.some((p) => (p.providerMcpIds?.length ?? 0) > 0);
  useEffect(() => {
    if (!needsProviderCheck) {
      setMcpServers([]);
      return;
    }
    void window.api?.mcp?.listServers?.().then((list) => setMcpServers(list ?? []));
  }, [needsProviderCheck]);

  const availableMcpServerNames = useMemo(
    () => new Set(mcpServers.filter((s) => s.installed && !s.disabled).map((s) => s.name)),
    [mcpServers],
  );
  // 无任务 = 全局 selection（跟随当前模式，始终合法）；有（未锁定）任务 = 任务 selection
  const selectedPresetId = task?.modePresetId ?? modePresetId;
  const presetChips = useMemo(
    () =>
      buildPresetBarChips({
        presets,
        selectedPresetId,
        availableMcpServerNames,
        locked: isTaskModeLocked(task),
      }),
    [presets, selectedPresetId, availableMcpServerNames, task],
  );

  const selectPreset = (presetId: string): void => {
    setModePreset(presetId);
  };

  const headline = heroHeadline(welcomeMode, selectedPresetId);
  const sceneKey = `${welcomeMode}:${selectedPresetId ?? ""}`;
  useEffect(() => {
    setActivePrompt(null);
  }, [sceneKey]);
  const subtitle = activePrompt ?? heroSubline(welcomeMode, selectedPresetId);

  return (
    <div className="hero" data-mode={welcomeMode}>
      <div className="hero-copy">
        <div className="hero-brand">
          <span className="brand-mybuddy"><span className="brand-my">My</span><span className="brand-buddy">Buddy</span></span>
        </div>
        <h1 className="hero-title">{headline}</h1>
        <p className="hero-subtitle">{subtitle}</p>
      </div>

      <div className="hero-categories">
        {heroCategories.map((c) => {
          const mode = categoryToMode[c] ?? DEFAULT_WELCOME_MODE;
          return (
            <button
              key={c}
              type="button"
              className={`pill ${c === category ? "dark" : ""}`}
              aria-pressed={c === category}
              onClick={() => setWelcomeMode(mode)}
            >
              <WelcomeModeIcon mode={mode} size={13} />
              {c}
            </button>
          );
        })}
      </div>

      <div className="hero-scenes">
        {presetChips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`scene-chip preset-chip${chip.selected ? " selected" : ""}`}
            disabled={chip.disabled}
            title={chip.title ?? chip.description}
            aria-pressed={chip.selected}
            onClick={() => selectPreset(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="hero-composer">
        <div className="hero-input-wrap">
          <ChatInput variant="home" scenePresetId={selectedPresetId} />
        </div>
        <HeroSuggestChips
          welcomeMode={welcomeMode}
          presetId={selectedPresetId}
          onSelect={(prompt) => {
            setActivePrompt(prompt);
            fillComposer(prompt);
          }}
          onPromptRenamed={(from, to) => {
            setActivePrompt((prev) => (prev === from ? to : prev));
          }}
          onPromptRemoved={(prompt) => {
            setActivePrompt((prev) => (prev === prompt ? null : prev));
          }}
        />
      </div>

      {recentTasks.length > 0 && (
        <div className="hero-recent">
          <div className="hero-recent-label">最近</div>
          <div className="hero-recent-list">
            {recentTasks.map((item) => {
              const spaceLabel = recentSpaceLabel(spaces, item.spaceId);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="hero-recent-item"
                  title={spaceLabel}
                  onClick={() => setActiveTask(item.id)}
                >
                  <WelcomeModeIcon mode={item.welcomeMode} size={13} />
                  <span className="hero-recent-title">{item.title || "未命名任务"}</span>
                  <span className="hero-recent-space">{spaceLabel}</span>
                  <span className="hero-recent-time">{formatRecentTime(item.updatedAt)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 侧边栏折叠后，头部左侧只保留「展开侧边栏」 */
function CollapsedSidebarActions(): React.JSX.Element | null {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  if (!collapsed) return null;
  return (
    <button className="icon-btn" title="展开侧边栏" onClick={toggleSidebar}>
      <IconPanel size={15} />
    </button>
  );
}

function HistoryPopup({
  onClose,
  onJumpToMessage,
}: {
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}): React.JSX.Element | null {
  const task = useActiveTask();
  const questions = (task?.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => ({
      id: m.id,
      text: m.blocks
        .map((b) => (b.type === "text" ? b.text : ""))
        .join(" ")
        .trim(),
    }))
    .filter((q) => q.text)
    .reverse();

  return (
    <div className="history-popup">
      <div className="history-popup-title">历史提问 ({questions.length})</div>
      <div className="history-popup-list">
        {questions.map((q) => (
          <button
            key={q.id}
            className="history-popup-item"
            onClick={() => {
              onJumpToMessage(q.id);
              onClose();
            }}
          >
            {q.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageList({
  taskId,
  messages,
  artifacts,
  visibleArtifacts,
  scrollRef,
  apiRef,
  followStateRef,
  programmaticTargetRef,
}: {
  taskId: string;
  messages: NonNullable<ReturnType<typeof useActiveTask>>["messages"];
  artifacts: Artifact[];
  /** V3.6：产物面板过滤后的可见列表（仅用于「查看所有产物」计数；chips 仍用全量 artifacts） */
  visibleArtifacts?: Artifact[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  apiRef: React.MutableRefObject<{
    scrollToMessageId: (id: string, smooth?: boolean) => void;
    getMessageOffset: (id: string) => number | null;
  } | null>;
  /** 滚动意图状态机（单一真源；补偿决策与虚拟布局回调用） */
  followStateRef: React.MutableRefObject<FollowState>;
  /** 未决的程序化滚动目标：非 null 时视口位置由外部补偿独占，虚拟器不得再补一次 */
  programmaticTargetRef: React.MutableRefObject<number | null>;
}): React.JSX.Element {
  const useVirtual = messages.length > MESSAGE_VIRTUALIZE_THRESHOLD;
  /** P2：滚动中冻结 measureElement，停止后再统一重测，避免每帧 ResizeObserver 重排 */
  const scrollingRef = useRef(false);
  const virtualizerRef = useRef<unknown>(null);
  const scrollStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getItemKey: (index) => messages[index]?.id ?? index,
    getScrollElement: () => scrollRef.current,
    // 内容感知估算：缩小首测 delta 与初始 totalSize 误差（滚动安全由
    // shouldAdjustScrollCompensation 保证，不依赖估算精度）
    estimateSize: (index) => {
      const msg = messages[index];
      return msg ? estimateMessageHeight(msg) : 160;
    },
    // P2：P0/P1 已把图片内存压住，用 3 行常驻换掉挂载/卸载抖振
    overscan: 3,
    enabled: useVirtual,
    // 默认从列表末尾附近开始，随后由 ChatView 把最新用户消息置顶
    initialOffset: () => Number.MAX_SAFE_INTEGER,
    // 历史消息可能在滚动容器首次挂载的同一帧恢复；先给虚拟器一个
    // 可用视口，随后 ResizeObserver 会用真实尺寸替换它。
    initialRect: { width: 800, height: 640 },
    // 把 virtualizer 的行尺寸变化滚动补偿纳入单一滚动意图状态机：
    // follow=true 时不让尺寸重测主动改 scrollTop；新一轮置顶由 ChatView 单次执行；
    // follow=false（用户接管）时仅允许「行真实下边缘完全在折叠线上方」的锚点
    // 补偿，禁止把用户视口向下拖（#1218：流式行增长在折叠线下方不位移视口）。
    shouldAdjustScrollPositionOnItemSizeChange: (item, delta, instance) =>
      shouldAdjustScrollCompensation({
        itemStart: item.start,
        cachedSize: item.size,
        delta,
        scrollOffset: (instance.scrollOffset ?? 0) + instance.scrollAdjustments,
        scrollDirection: instance.scrollDirection,
        follow: followStateRef.current.follow,
        compensationOwned: programmaticTargetRef.current !== null,
      }),
    measureElement:
      typeof window !== "undefined" && navigator.userAgent.indexOf("Firefox") === -1
        ? (el) => {
            // 滚动中不要接受新的实测高度：返回该行上一次的测量值，
            // 否则图片 onload / 骨架塌陷会在拖动时反复改动 totalSize。
            if (scrollingRef.current) {
              const index = Number(el.getAttribute("data-index"));
              const instance = virtualizerRef.current as unknown as {
                getMeasurements?: () => Array<{ index: number; size: number }>;
              } | null;
              const cached = instance?.getMeasurements?.().find((m) => m.index === index)?.size;
              if (typeof cached === "number" && cached > 0) return cached;
            }
            return el.getBoundingClientRect().height;
          }
        : undefined,
  } as VirtualizerOptionsWithCompensation);
  virtualizerRef.current = virtualizer;

  apiRef.current = {
    getMessageOffset: (id) => {
      const idx = messages.findIndex((m) => m.id === id);
      if (idx < 0) return null;
      if (useVirtual) return virtualizer.getOffsetForIndex(idx, "start")?.[0] ?? null;
      const el = scrollRef.current;
      const node = document.getElementById(`msg-${id}`);
      if (!el || !node) return null;
      return (
        el.scrollTop +
        (node.getBoundingClientRect().top - el.getBoundingClientRect().top)
      );
    },
    scrollToMessageId: (id, smooth = true) => {
      const idx = messages.findIndex((m) => m.id === id);
      if (idx < 0) return;
      if (useVirtual) {
        virtualizer.scrollToIndex(idx, { align: "start", behavior: smooth ? "smooth" : "auto" });
      } else {
        const el = scrollRef.current;
        const node = document.getElementById(`msg-${id}`);
        if (!el || !node) return;
        const top =
          el.scrollTop +
          (node.getBoundingClientRect().top - el.getBoundingClientRect().top) -
          TURN_TOP_OFFSET;
        el.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
      }
    },
  };

  // P2：滚动事件驱动冻结窗口；120ms 无滚动视为停止，补一次统一重测
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      scrollingRef.current = true;
      if (scrollStopTimerRef.current !== null) clearTimeout(scrollStopTimerRef.current);
      scrollStopTimerRef.current = setTimeout(() => {
        scrollingRef.current = false;
        scrollStopTimerRef.current = null;
        const instance = virtualizerRef.current as unknown as { measure?: () => void } | null;
        instance?.measure?.();
      }, 120);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (scrollStopTimerRef.current !== null) {
        clearTimeout(scrollStopTimerRef.current);
        scrollStopTimerRef.current = null;
      }
    };
  }, [scrollRef]);

  const tailMessage = messages[messages.length - 1];
  // 从用户发送到 assistant_end 都属于同一轮置顶期。不能在第一段思考/正文
  // 出现时撤掉缓冲，否则 scrollHeight 收缩会与 ResizeObserver 的跟随写竞争，
  // 把视口切成贴底并在流式增长时持续向下拉。
  const needsTurnAnchorSpace =
    tailMessage?.role === "user" ||
    (tailMessage?.role === "assistant" && Boolean(tailMessage.streaming));

  if (!useVirtual) {
    return (
      <div className={`message-list${needsTurnAnchorSpace ? " message-list--turn-anchor" : ""}`}>
        {messages.map((msg) => (
          <div key={msg.presentationKey ?? msg.id} id={`msg-${msg.id}`}>
            <MessageItem message={msg} taskId={taskId} artifacts={artifacts} visibleArtifacts={visibleArtifacts} />
          </div>
        ))}
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();
  // 仅在当前轮仍进行中时保留置顶缓冲；assistant_end 后收回，避免历史底部留白。
  const bottomPad = needsTurnAnchorSpace
    ? (typeof window !== "undefined" ? Math.round(window.innerHeight * 0.48) : 360)
    : 12;

  return (
    <div
      className={`message-list message-list--virtual${needsTurnAnchorSpace ? " message-list--turn-anchor" : ""}`}
      style={{ height: virtualizer.getTotalSize() + bottomPad }}
    >
      {items.map((item) => {
        const msg = messages[item.index];
        return (
          <div
            key={msg.presentationKey ?? msg.id}
            id={`msg-${msg.id}`}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="message-list-virtual-row"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <MessageItem message={msg} taskId={taskId} artifacts={artifacts} visibleArtifacts={visibleArtifacts} />
          </div>
        );
      })}
    </div>
  );
}

export default function ChatView(): React.JSX.Element {
  const task = useActiveTask();
  const draftProjectId = useAppStore((s) => s.draft?.projectId);
  const draftSpaceId = useAppStore((s) => s.draft?.spaceId);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  // 3E：产物直读 projection 派生视图（task.artifacts 已退役）
  const artifacts = useActiveTaskArtifacts();
  // 与产物面板同一套可见列表：消息芯片 / 「查看所有产物」计数都走过滤版
  const visibleArtifacts = useVisibleTaskArtifacts();
  const renameTask = useAppStore((s) => s.renameTask);
  const bindTaskSpace = useAppStore((s) => s.bindTaskSpace);
  const spaces = useAppStore((s) => s.spaces);
  const experts = useAppStore((s) => s.experts);
  const connectors = useAppStore((s) => s.connectors);
  const panelOpen = useAppStore((s) => s.panelOpen);
  const closePanel = useAppStore((s) => s.closePanel);
  const showOverview = useAppStore((s) => s.showOverview);
  const branchError = useAppStore((s) => s.branchError);
  const clearBranchError = useAppStore((s) => s.clearBranchError);

  /** 关栏后再开：打开概览 */
  const openSidePanel = (): void => {
    showOverview();
  };

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const expertSnapshot = task?.expertBinding?.desired ?? (task?.expertBinding?.pending ? task.expertBinding.active : null);
  const taskExpert = expertSnapshot ? { name: expertSnapshot.name, emoji: experts.find((e) => e.id === expertSnapshot.sourceExpertId)?.emoji } : task?.expertId ? experts.find((e) => e.id === task.expertId) ?? { name: task.expertId, emoji: undefined } : undefined;
  const capabilityNotices = task?.capabilityNotices ?? [];
  const capabilityName = (kind: "expert" | "connector" | "mcp", id: string): string => {
    if (kind === "mcp") return id;
    if (kind === "connector") return connectors.find((item) => item.id === id)?.name ?? id;
    return experts.find((item) => item.id === id)?.name ?? id;
  };
  const policyLabel = (source?: string): string => {
    if (source === "project") return "Project Policy";
    if (source === "tag") return "Tag Policy";
    if (source === "mode") return "Mode Policy";
    return "运行时策略";
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * 已加载的更早历史窗口。seed 是首次加载时实时窗口的 historyBefore：实时窗口一旦前滚驱逐，
   * 这一段块与实时窗口之间就无法再保证衔接（中间消息已被逐出），必须整段作废。
   */
  const visibleWindow = task?.historyWindow?.epoch === task?.durable?.epoch
    && task?.historyWindow?.seed === task?.durable?.historyBefore ? task?.historyWindow : undefined;
  const beforeHistory = visibleWindow ? visibleWindow.before : task?.durable?.historyBefore;
  /** 上一帧的消息列表：用来判定本轮渲染是「前插」还是真的出现了新消息 */
  const previousDisplayMessagesRef = useRef<ChatMessage[]>([]);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyAnchorRef = useRef<HTMLDivElement>(null);
  const taskMenuAnchorRef = useRef<HTMLDivElement>(null);
  const previousTaskIdRef = useRef<string | undefined>(undefined);
  const previousMessageCountRef = useRef(0);
  /** 仅记录本地 composer 的显式发送；后台追加消息不能借此抢走历史阅读位置。 */
  const pendingLocalSendRef = useRef(false);
  const listApiRef = useRef<{
    scrollToMessageId: (id: string, smooth?: boolean) => void;
    getMessageOffset: (id: string) => number | null;
  } | null>(null);

  useDismissOnClickOutside(historyOpen, () => setHistoryOpen(false), historyAnchorRef);
  useDismissOnClickOutside(taskMenuOpen, () => setTaskMenuOpen(false), taskMenuAnchorRef);
  /** 诊断弹窗绑定当前任务：切换任务即关闭，避免仍显示上一个任务的记录 */
  useEffect(() => setDiagnosticsOpen(false), [task?.id]);

  const displayMessages = useMemo(() => {
    const live = task?.messages ?? [];
    const messages = visibleWindow ? mergeHistoryWindow([visibleWindow.messages], live) : live;
    return task?.durable !== undefined || task?.welcomeMode === "bot"
      ? botMessagePresentation(messages, task.durable?.pendingInputs) : messages;
  }, [visibleWindow, task?.messages, task?.welcomeMode, task?.durable, task?.durable?.pendingInputs]);
  const messageCount = displayMessages.length;
  const hasMessages = messageCount > 0;
  const lastMessage = displayMessages[messageCount - 1];

  /** 找到最近一条用户消息 id（新一轮对话的锚点） */
  const latestUserMessageId = useCallback((): string | null => {
    const messages = displayMessages;
    if (!messages?.length) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return null;
  }, [displayMessages]);

  /* ------------------------------------------------------------------
   * 滚动意图状态机（单一真源 lib/scrollFollow）：
   * - followStateRef 保存完整状态（避免高频 scroll 事件触发重渲染）；
   * - followVisible 仅镜像 follow 翻转，用于「回到底部」按钮显隐；
   * - followRef 供新一轮门控与高频输入事件同步读取。
   * ------------------------------------------------------------------ */
  const followStateRef = useRef<FollowState>(initialFollowState());
  const [followVisible, setFollowVisible] = useState(true);
  const followRef = useRef(true);
  /** 程序化滚动防护：置顶写目标（数字）；到达前忽略 scroll 事件 */
  const programmaticTargetRef = useRef<number | null>(null);
  /** 上次记录的 scrollTop（无手势 scroll 事件的方向推断用） */
  const lastScrollTopRef = useRef(0);

  /** 提交状态机转移：ref 保存真源；仅当 follow 翻转时同步镜像给按钮显隐/门控。 */
  const commitFollow = useCallback((next: FollowState): void => {
    const prev = followStateRef.current;
    followStateRef.current = next;
    followRef.current = next.follow;
    if (prev.follow !== next.follow) setFollowVisible(next.follow);
  }, []);

  const bottomDistance = useCallback((): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    return el.scrollHeight - el.clientHeight - el.scrollTop;
  }, []);

  /** 程序化写 scrollTop（带防护）：到达目标前的 scroll 事件一律视为程序滚动。
   *  P2-2：写入前把 target clamp 到 maxScrollTop —— 浏览器会 clamp 越界赋值，
   *  若目标不可达则 programmaticTargetRef 永不释放、guard 永久卡死。 */
  const applyProgrammaticScrollTop = useCallback((top: number): void => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const target = Math.max(0, Math.min(top, maxScrollTop));
    if (Math.abs(el.scrollTop - target) < 1) return;
    programmaticTargetRef.current = target;
    el.scrollTop = target;
    lastScrollTopRef.current = target;
  }, []);

  /** 更早历史的前插、游标推进、作废令牌与滚动补偿都归这个控制器管 */
  const { requestEarlier, clearWindow } = useEarlierHistory({
    taskId: task?.id,
    cursor: beforeHistory,
    scrollRef,
    applyProgrammaticScrollTop,
  });

  const latestUserMessageIdRef = useRef(latestUserMessageId);
  latestUserMessageIdRef.current = latestUserMessageId;

  /**
   * 官方 MyBuddy：发送后本轮用户气泡置顶，助手内容在下方展开，底部留白。
   * 不贴底滚动。置顶只在新一轮开始时执行一次；streaming / ResizeObserver / virtualizer
   * 布局变化都没有 scrollTop 写权限，避免与用户滚动竞争。
   */
  const pinUserMessageToTop = useCallback(
    (messageId?: string | null): void => {
      const id = messageId ?? latestUserMessageIdRef.current();
      const el = scrollRef.current;
      if (!id || !el) return;

      const node = document.getElementById(`msg-${id}`);
      if (!node) {
        // 虚拟行尚未挂载时只读取 virtualizer 当前测量得到的目标 offset，
        // 仍由唯一的 guarded scrollTop 写入口执行一次。不要调用 scrollToIndex：
        // TanStack 会对动态尺寸目标持续 reconcile，多轮测量时会与用户滚动争抢。
        const virtualTop = listApiRef.current?.getMessageOffset(id);
        if (virtualTop !== null && virtualTop !== undefined) {
          applyProgrammaticScrollTop(Math.max(0, virtualTop - TURN_TOP_OFFSET));
        }
        return;
      }

      const nextTop =
        el.scrollTop +
        (node.getBoundingClientRect().top - el.getBoundingClientRect().top) -
        TURN_TOP_OFFSET;
      applyProgrammaticScrollTop(Math.max(0, nextTop));
    },
    [applyProgrammaticScrollTop],
  );

  const pinUserMessageToTopRef = useRef(pinUserMessageToTop);
  pinUserMessageToTopRef.current = pinUserMessageToTop;

  // 发送新消息 / 切换任务 / 恢复历史：把「最新用户消息」置顶（对齐官方）。
  // 新一轮置顶仅在用户未接管滚动（follow=true）时执行（shouldPinOnNewTurn）：
  // 用户上拉阅读历史期间新消息/新 assistant 不得把视口拉回（需求 4）。
  useLayoutEffect(() => {
    const taskChanged = previousTaskIdRef.current !== task?.id;
    const previousMessageCount = previousMessageCountRef.current;
    const messageAdded = messageCount > previousMessageCount;
    const historyRestored = previousMessageCount === 0 && messageCount > 0;
    previousTaskIdRef.current = task?.id;
    previousMessageCountRef.current = messageCount;
    // 前插只往头部加旧消息：它不是一次新回合，不能拥有滚动写权限。
    // 用「上一帧列表」判定而不是外部开关：少一个需要手动复位的可变状态。
    const prepended = isPrependOnly(previousDisplayMessagesRef.current, displayMessages);
    previousDisplayMessagesRef.current = displayMessages;

    if (!hasMessages || prepended) return;

    // 新一轮置顶语义（P1-1）：仅「用户新消息」触发 resetAndPin；
    // assistant streaming 新消息仅在它是用户发送后的首个回复（前一条是 user）
    // 时视为新一轮（与 user 分支幂等，覆盖 user+assistant 同批入列）。
    // 工具循环/tool-loop 的后续 assistant turn（前一条是 assistant）不得
    // 重置滚动——新一轮只做一次置顶；之后布局变化不再拥有滚动写权限。
    const prevMessage = messageCount >= 2 ? displayMessages[messageCount - 2] : undefined;
    const isAssistantTurnStart =
      lastMessage?.role === "assistant" &&
      Boolean(lastMessage.streaming) &&
      prevMessage?.role === "user";
    const isNewTurn = messageAdded && (lastMessage?.role === "user" || isAssistantTurnStart);

    const resetAndPin = (): void => {
      commitFollow(onResetForTask(followStateRef.current));
      // 新一轮只做一次置顶。先让 MessageList/virtualizer 提交一帧 DOM，
      // 避免目标行尚未挂载时进入 scrollToIndex 的持续 reconcile。
      requestAnimationFrame(() => {
        pinUserMessageToTopRef.current();
      });
    };

    if (taskChanged || historyRestored) {
      resetAndPin();
      return;
    }
    if (pendingLocalSendRef.current && isNewTurn) {
      pendingLocalSendRef.current = false;
      resetAndPin();
      return;
    }
    if (shouldPinOnNewTurn(followRef.current, isNewTurn)) {
      resetAndPin();
    }
  }, [
    task?.id,
    messageCount,
    hasMessages,
    lastMessage?.role,
    lastMessage?.streaming,
    commitFollow,
  ]);

  // 用户滚动意图监听（wheel / 指针拖动 / 键盘）+ 程序化滚动防护。
  // 判定优先「scroll position + programmatic guard」：
  // - 程序化滚动（置顶目标/burst）到达前的 scroll 事件一律忽略，不改变状态；
  // - wheel/键盘/指针给出明确手势方向（需求 5）；
  // - 无手势方向且非程序的 scroll 事件（滚动条拖动等在部分浏览器不派发
  //   pointerdown）→ 按 scrollTop 位移方向推断用户意图。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !hasMessages) return;
    lastScrollTopRef.current = element.scrollTop;

    const handleScroll = (): void => {
      const el = scrollRef.current;
      if (!el) return;
      // 程序滚动防护：一次性置顶目标到达前忽略对应 scroll 事件。
      // P2-2：写入后内容收缩导致 maxScrollTop 减小、target 不可达时，越界即释放 guard，
      // 绝不永久卡死（写入前已 clamp，此处为内容再收缩的兜底）。
      if (programmaticTargetRef.current !== null) {
        const target = programmaticTargetRef.current;
        const targetResolved =
          Math.abs(el.scrollTop - target) <= 2 ||
          target > Math.max(0, el.scrollHeight - el.clientHeight);
        programmaticTargetRef.current = null;
        if (targetResolved) {
          lastScrollTopRef.current = el.scrollTop;
          return;
        }
        // scrollTop 直接赋值是同步的；事件到达时若位置已经偏离目标，说明用户
        // 抢先拖动了滚动条（部分 Chromium 路径不派发 pointerdown）。清 guard
        // 后继续按真实位移处理，不能把用户位置重新 pin 回旧目标。
      }
      const prevTop = lastScrollTopRef.current;
      lastScrollTopRef.current = el.scrollTop;
      const delta = el.scrollTop - prevTop;
      // 位移动到顶时 wheel 已不再派发（scrollTop 卡在 0），抓拖滚动条/触摸的用户只能靠位移触发
      if (delta < 0) requestEarlier();
      const s = followStateRef.current;
      if (
        !s.pointerScrolling &&
        s.direction === null &&
        s.wheelUpPending === false &&
        delta !== 0 &&
        shouldInferUserScroll(delta, bottomDistance())
      ) {
        // 无手势方向的非程序滚动：按位移推断（滚动条拖动、触摸、未捕获的键盘滚动）。
        // wheelUpPending 时跳过推断——由 onFollowScroll(scrollDelta) 统一确认候选。
        commitFollow(delta < 0 ? onUserScrollUp(s) : onUserScrollDown(s));
      }
      const next = onFollowScroll(followStateRef.current, bottomDistance(), delta);
      if (next.follow && next.direction === "down") {
        // 向下手势已解析（落到底部阈值内）：清除方向锁，恢复自动跟随
        commitFollow({ ...next, direction: null });
      } else {
        commitFollow(next);
      }
    };
    const markWheelIntent = (event: WheelEvent): void => {
      // 用户手势打断未决的程序滚动目标
      programmaticTargetRef.current = null;
      if (event.deltaY < 0) requestEarlier();
      if (event.deltaY < 0) {
        // P2-1：wheel 上滚只登记候选（触底回弹/惯性零位移不锁存）；
        // 实际向上位移由 handleScroll → onFollowScroll(scrollDelta<0) 确认锁存。
        commitFollow(onWheelUpCandidate(followStateRef.current));
      } else if (event.deltaY > 0) {
        // 向下意图：清除 wheel 上滚候选（用户实际在向下滚）并锁存方向
        commitFollow(onUserScrollDown(followStateRef.current));
      }
    };
    const markPointerIntent = (event: PointerEvent): void => {
      // 滚动条拖动与触摸滚动：目标为容器本身，或任何触摸指针（触摸滚动任意子元素）
      if (event.target !== element && event.pointerType !== "touch") return;
      programmaticTargetRef.current = null;
      commitFollow(onPointerDown(followStateRef.current, bottomDistance()));
    };
    const clearPointerIntent = (): void => {
      commitFollow(onPointerUp(followStateRef.current, bottomDistance()));
    };
    const cancelPointerIntent = (): void => {
      commitFollow(onPointerCancel(followStateRef.current));
    };
    const markKeyboardIntent = (event: KeyboardEvent): void => {
      // 只识别滚动容器内的键盘目标（容器自身/其子控件）；输入框与 Space 激活控件除外
      const target = event.target;
      if (!element.contains(target as Node)) return;
      const editable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      const activatesOnSpace =
        target instanceof HTMLButtonElement ||
        target instanceof HTMLAnchorElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.getAttribute?.("role") === "button");
      const intent = keyboardIntent(event.key, event.shiftKey, editable, activatesOnSpace);
      if (intent === null) return;
      programmaticTargetRef.current = null;
      commitFollow(
        intent === "up"
          ? onUserScrollUp(followStateRef.current)
          : onUserScrollDown(followStateRef.current),
      );
    };

    element.addEventListener("scroll", handleScroll, { passive: true });
    element.addEventListener("wheel", markWheelIntent, { passive: true });
    element.addEventListener("pointerdown", markPointerIntent, { passive: true });
    // P2-3：pointerup/pointercancel 挂 document 级 —— 鼠标按下容器空白后拖出容器
    // 再松手时，element 收不到 pointerup（鼠标无隐式 pointer capture），
    // 会导致 pointerScrolling 永久 true、滚动判定冻结。document 级监听保证
    // 任意位置松手都结算；cleanup 对称移除。
    document.addEventListener("pointerup", clearPointerIntent);
    document.addEventListener("pointercancel", cancelPointerIntent);
    document.addEventListener("keydown", markKeyboardIntent);
    return () => {
      element.removeEventListener("scroll", handleScroll);
      element.removeEventListener("wheel", markWheelIntent);
      element.removeEventListener("pointerdown", markPointerIntent);
      document.removeEventListener("pointerup", clearPointerIntent);
      document.removeEventListener("pointercancel", cancelPointerIntent);
      document.removeEventListener("keydown", markKeyboardIntent);
    };
  }, [task?.id, hasMessages, commitFollow, bottomDistance, requestEarlier]);

  // 无选中任务，或新建空任务（尚无 session）→ 首页 Hero
  // 有 sessionFile 但 messages 暂空 → 恢复中，进聊天区（避免被当成「打不开」）
  const boundProjectId = task?.projectId ?? draftProjectId;
  const sidePanelButton = <button className={`icon-btn ${panelOpen ? "toggled" : ""}`} title={panelOpen ? "关闭侧栏" : "打开概览"}
    onClick={() => (panelOpen ? closePanel() : openSidePanel())}><IconPanel size={15} /></button>;

  // Admission and errors remain visible before the first native message arrives.
  if (!task || (task.welcomeMode !== "bot" && task.messages.length === 0 && !task.sessionFile && !task.durable && !task.botPendingSubmission && !task.botInputError)) {
    const showHeroHeader = Boolean(task || sidebarCollapsed || boundProjectId || draftSpaceId);
    return (
      <>
        {showHeroHeader && (
          <div className="chat-header hero-header">
            <CollapsedSidebarActions />
            {boundProjectId && <ChatProjectCrumb projectId={boundProjectId} />}
            {draftSpaceId ? <WorkspaceCrumb spaceId={draftSpaceId} /> : null}
            <div className="chat-header-sub" />
            {task && sidePanelButton}
          </div>
        )}
        <HomeHero />
      </>
    );
  }

  const taskMode: WelcomeMode =
    task.welcomeMode === "working" || task.welcomeMode === "bot" || task.welcomeMode === "coding"
      ? task.welcomeMode
      : "coding";

  if (task.messages.length === 0) {
    return (
      <div className="chat-column task-ambient" data-mode={taskMode}>
        <div className="chat-header task-chat-header">
          <CollapsedSidebarActions />
          {task.projectId && <ChatProjectCrumb projectId={task.projectId} trailingSlash />}
          <WorkspaceCrumb spaceId={task.spaceId ?? null} />
          <div className="chat-header-title">{task.title || "任务"}</div>
          {task.welcomeMode !== "bot" && <ConversationGoalChip taskId={task.id} goal={task.activeGoal} />}
          <ConversationBranchChip />
          <span
            className="chat-mode-chip"
            title={`场景：${WELCOME_MODE_LABELS[task.welcomeMode ?? DEFAULT_WELCOME_MODE]}（已锁定，换场景请复制为新任务）`}
          >
            <WelcomeModeIcon mode={task.welcomeMode} size={13} showLabel />
          </span>
          {taskExpert && (
            <span className="chat-expert-chip" title={`专家：${taskExpert.name}`}>
              <span className="chat-expert-chip-symbol" aria-hidden="true">
                {taskExpert.emoji || "🧙"}
              </span>
              <span className="chat-expert-chip-label">{taskExpert.name}</span>
            </span>
          )}
          <RuntimeStatusChips modePresetId={task.modePresetId} />
          <div className="input-spacer" />
          {sidePanelButton}
        </div>
        <div className="chat-scroll">
          {task.botPendingSubmission && <div className="bot-submission-preview">
            <div className="bot-submission-input">{task.botPendingSubmission.text}
              {task.botPendingSubmission.attachmentNames.map((name, index) => <span className="bot-submission-attachment" key={index}>{name}</span>)}
            </div>
            <div className="bot-submission-status" role="status"><span className="bot-submission-spinner" aria-hidden="true" />正在准备回复…</div>
          </div>}
          {!task.botPendingSubmission && !task.historyError &&
          <div className="empty-block" style={{ margin: "48px auto" }}>
            <div className="empty-block-title">{task.durable || task.welcomeMode === "bot" ? "会话" : "正在加载历史对话…"}</div>
            <div style={{ fontSize: 12.5 }}>{task.durable || task.welcomeMode === "bot" ? "消息接受后将显示在这里" : "正在从会话文件恢复消息"}</div>
          </div>}
          {task.historyError &&
          <div className="empty-block" style={{ margin: "48px auto" }} role="alert" data-testid="history-error">
            <div className="empty-block-title">会话记录打不开</div>
            <div style={{ fontSize: 12.5 }}>{task.historyError}</div>
          </div>}
        </div>
        {task.botInputError && <div className="durable-bot-state" role="alert">{task.botInputError}</div>}
        <SessionHistoryRecoveryNotice recovery={task.sessionRecovery} />
        <TaskModelRecoveryNotice recovery={task.modelRecovery} />
        {task.welcomeMode !== "bot" && <TaskRecoveryNotice key={task.id} taskId={task.id} projectId={task.projectId} refreshKey="history" />}
        <ChatInput variant="chat" />
      </div>
    );
  }

  const commitTitle = (): void => {
    if (titleDraft.trim()) renameTask(task.id, titleDraft.trim());
    setEditingTitle(false);
  };

  const modeLocked = task.messages.length > 0 || Boolean(task.sessionFile);

  return (
    <div className="chat-column task-ambient" data-mode={taskMode}>
      <div className="chat-header task-chat-header">
        <CollapsedSidebarActions />
        {task.projectId && <ChatProjectCrumb projectId={task.projectId} trailingSlash />}
        <WorkspaceCrumb spaceId={task.spaceId ?? null} />
        <div className="chat-header-title">
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => e.key === "Enter" && commitTitle()}
            />
          ) : (
            <span
              onDoubleClick={() => {
                setTitleDraft(task.title);
                setEditingTitle(true);
              }}
              title="双击重命名"
            >
              {task.title}
            </span>
          )}
        </div>
        <div className="chat-header-sub" />
        {task.welcomeMode !== "bot" && <ConversationGoalChip taskId={task.id} goal={task.activeGoal} />}
        <ConversationBranchChip />
        <span
          className="chat-mode-chip"
          title={
            modeLocked
              ? `场景：${WELCOME_MODE_LABELS[task.welcomeMode ?? DEFAULT_WELCOME_MODE]}（已锁定）。换场景：任务菜单「复制为…任务」`
              : `场景：${WELCOME_MODE_LABELS[task.welcomeMode ?? DEFAULT_WELCOME_MODE]}`
          }
        >
          <WelcomeModeIcon mode={task.welcomeMode} size={13} showLabel />
        </span>
        {taskExpert && (
          <span className="chat-expert-chip" title={`专家：${taskExpert.name}`}>
            <span className="chat-expert-chip-symbol" aria-hidden="true">
              {taskExpert.emoji || "🧙"}
            </span>
            <span className="chat-expert-chip-label">{taskExpert.name}</span>
          </span>
        )}
          <RuntimeStatusChips modePresetId={task.modePresetId} />
        <div className="history-anchor" ref={historyAnchorRef}>
          <button
            className={`icon-btn ${historyOpen ? "toggled" : ""}`}
            title="历史提问"
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <IconClock size={15} />
          </button>
          {historyOpen && (
            <HistoryPopup
              onClose={() => setHistoryOpen(false)}
              onJumpToMessage={(id) => {
                // 历史跳转：退出跟随并清除手势方向（随后是程序化平滑滚动，不改变状态）
                commitFollow(onHistoryJump(followStateRef.current));
                listApiRef.current?.scrollToMessageId(id);
              }}
            />
          )}
        </div>
        <div className="history-anchor" ref={taskMenuAnchorRef}>
          <button
            className={`icon-btn ${taskMenuOpen ? "toggled" : ""}`}
            title="任务菜单"
            aria-haspopup="dialog"
            aria-expanded={taskMenuOpen}
            onClick={() => setTaskMenuOpen(!taskMenuOpen)}
          >
            <IconMore size={15} />
          </button>
          {taskMenuOpen && (
            <TaskWriteGrantsMenu
              taskId={task.id}
              onClose={() => setTaskMenuOpen(false)}
              onOpenDiagnostics={() => {
                setTaskMenuOpen(false);
                setDiagnosticsOpen(true);
              }}
            />
          )}
        </div>
        {sidePanelButton}
      </div>
      {diagnosticsOpen && (
        <TaskDiagnosticsDialog taskId={task.id} onClose={() => setDiagnosticsOpen(false)} />
      )}


      <div className="chat-viewport">
        <div className="message-scroll" ref={scrollRef}>
          {branchError && branchError.taskId === task.id && (
            <div className="conv-branch-error" role="alert">
              <IconAlert size={15} />
              <div className="conv-branch-error-text">{branchError.message}</div>
              <button
                type="button"
                className="conv-branch-error-close"
                title="关闭"
                onClick={clearBranchError}
              >
                <IconX size={13} />
              </button>
            </div>
          )}
          {capabilityNotices.length > 0 && (
            <div className="capability-policy-notice" role="status">
              <IconAlert size={15} />
              <div>
                {capabilityNotices.map((notice) => (
                  <div key={`${notice.kind}:${notice.id}`} title={notice.reason}>
                    {notice.kind === "expert" ? "专家" : notice.kind === "connector" ? "连接器" : "MCP"}「{capabilityName(notice.kind, notice.id)}」未启用：
                    {notice.reason.endsWith("_not_allowed")
                      ? `不在 ${policyLabel(notice.source)} 允许列表中。`
                      : `被 ${policyLabel(notice.source)} 拒绝。`}
                  </div>
                ))}
              </div>
            </div>
          )}
          <MessageList
            taskId={task.id}
            key={task.id}
            messages={displayMessages}
            artifacts={artifacts}
            visibleArtifacts={visibleArtifacts}
            scrollRef={scrollRef}
            apiRef={listApiRef}
            followStateRef={followStateRef}
            programmaticTargetRef={programmaticTargetRef}
          />
        </div>
        {/* 用户接管滚动（上拉阅读历史）时出现；点击 = 显式「回到底部」动作。
            位于 chat viewport overlay 层（非滚动容器内）：消息怎么滚/虚拟行怎么重测，
            按钮视觉位置都不移动；固定在 composer 上方、与内容列对齐。 */}
        {(!followVisible || visibleWindow) && (
          <button
            type="button"
            className="jump-to-bottom"
            title="回到底部"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              clearWindow();
              commitFollow(onResetForTask(followStateRef.current));
              requestAnimationFrame(() => {
                pinUserMessageToTopRef.current();
              });
            }}
          >
            <IconChevronDown size={14} />
            回到底部
          </button>
        )}
      </div>

      <SessionHistoryRecoveryNotice recovery={task.sessionRecovery} />
      <TaskModelRecoveryNotice recovery={task.modelRecovery} />
      {task.welcomeMode !== "bot" && <TaskRecoveryNotice key={task.id} taskId={task.id} projectId={task.projectId} refreshKey={`${task.messages.length}:${task.messages.some((message) => message.streaming)}:${task.messages.filter((message) => message.generateError).length}`} />}
      {task.botInputError && <div className="durable-bot-state" role="alert">{task.botInputError}</div>}
      {task.durable && <div className="durable-bot-state" role="status">
        {task.durable.compacting && <div>Pi Durable 正在压缩上下文</div>}
        {task.durable.retry && <div>正在重试：{task.durable.retry.error}</div>}
        {task.durable.status === "waiting_input" && <div>等待你回答，关闭窗口后仍可继续</div>}
        {task.durable.status === "queued" && <div>已接收，等待执行</div>}
        {task.durable.status === "stopped" && <div>已停止</div>}
        {task.durable.status === "failed" && <div role="alert">执行失败：{task.durable.error ?? "请查看执行记录"}</div>}
      </div>}
      <ChatInput
        onBeforeSend={() => {
          pendingLocalSendRef.current = true;
          commitFollow(onResetForTask(followStateRef.current));
        }}
      />
    </div>
  );
}
