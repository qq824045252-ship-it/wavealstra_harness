import { UiIcon } from "@mybuddy/shared/icons";
import { useDotsDelegations, useTaskDotsDelivery } from "./DotsResult";
import { DotsAllTasks } from "./DotsActivity";
import { DOTS_TASK_ID } from "@shared/dots";
import { openVisitedTask } from "@/lib/taskBoardVisits";
import { DEFAULT_WELCOME_MODE } from "@shared/mode-profile";
import TaskRecoveryNotice from "./TaskRecoveryNotice";
import SessionHistoryRecoveryNotice from "./SessionHistoryRecoveryNotice";
import TaskModelRecoveryNotice from "./TaskModelRecoveryNotice";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useActiveTask, useActiveTaskArtifacts, useVisibleTaskArtifacts, useAppStore } from "@/store/appStore";
import type { Artifact, ChatMessage, Space } from "@/types";
import type { ConversationGoalDto } from "@shared/conversation-goal";
import ChatAnswerRuleDialog from "@/components/answer-routing/ChatAnswerRuleDialog";
import { botMessagePresentation } from "@/lib/botMessagePresentation";
import ChatInput from "./ChatInput";
import ConversationGoalChip from "./ConversationGoalChip";
import ConversationBranchChip from "./ConversationBranchChip";
import ChatProjectCrumb from "./ChatProjectCrumb";
import WorkspaceCrumb from "./WorkspaceCrumb";
import SubagentRunsChip from "./SubagentRunsChip";
import SubagentChatView from "./SubagentChatView";
import RuntimeStatusChips from "./RuntimeStatusChips";
import TaskDiagnosticsButton from "./TaskDiagnosticsButton";
import TaskDiagnosticsDialog from "./TaskDiagnosticsDialog";
import WelcomeModeIcon from "@/components/common/WelcomeModeIcon";
import {
  IconChevronDown,
  IconClock,
  IconDots,
  IconAlert,
  IconPanel,
  IconPanelRight,
  IconX,
} from "@/components/common/icons";
import type { McpServerDto, ModePresetDto, TaskUserQuestionDto, WelcomeMode } from "@shared/agent-ipc";
import { TASK_TITLE_MAX_CHARS } from "@shared/task-title";
import { WELCOME_MODES, WELCOME_MODE_LABELS } from "@shared/mode-profile";
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
  shouldInferUserScroll,
  type FollowState,
} from "@/lib/scrollFollow";
import { useChatHistory } from "./useChatHistory";
import { buildChatMessageRows, ChatMessageList } from "./ChatMessageList";
import { useHistoryQuestions } from "./useHistoryQuestions";
import { useDesktopShell } from "@/components/desktop/DesktopSection";
import { chatPinPosition, latestHumanMessageId } from "@/lib/chatPinPosition";

/** 新一轮用户消息置顶时距滚动容器顶的留白 */
const TURN_TOP_OFFSET = 8;
const RECENT_CHAT_ROWS = 100;
const OLDER_HISTORY_EDGE_PX = 360;

/** An explicit jump mounts estimated rows. Release it after the adjacent rows measure. */
function settleChatPlacement(place: () => void, finish: () => void): () => void {
  let remaining = 3;
  let frame = requestAnimationFrame(function settle() {
    place();
    if (--remaining > 0) frame = requestAnimationFrame(settle);
    else finish();
  });
  return () => cancelAnimationFrame(frame);
}

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
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setWelcomeMode = useAppStore((s) => s.setWelcomeMode);
  const modePresetId = useAppStore((s) => s.modePresetId);
  const setModePreset = useAppStore((s) => s.setModePreset);
  const fillComposer = useAppStore((s) => s.fillComposer);
  const tasks = useAppStore((s) => s.tasks);
  const spaces = useAppStore((s) => s.spaces);
  const task = useActiveTask();
  const [presets, setPresets] = useState<ModePresetDto[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerDto[]>([]);
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const recentTasks = useMemo(
    () =>
      tasks
        .filter((item) => item.id !== DOTS_TASK_ID && !item.archived && ((item.messages?.length ?? 0) > 0 || Boolean(item.sessionFile)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3),
    [tasks],
  );

  useEffect(() => {
    if (settingsOpen) return;
    let current = true;
    setPresets([]);
    void window.api?.agent?.getModeProfile?.(welcomeMode).then((p) => {
      if (current) setPresets(p?.policy?.presets ?? []);
    });
    return () => { current = false; };
  }, [welcomeMode, settingsOpen]);

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
        {WELCOME_MODES.map((mode) => {
          const c = WELCOME_MODE_LABELS[mode];
          return (
            <button
              key={c}
              type="button"
              className={`pill ${mode === welcomeMode ? "dark" : ""}`}
              aria-pressed={mode === welcomeMode}
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
                  onClick={() => openVisitedTask(item.id)}
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
  const desktop = useDesktopShell();
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  if (desktop || !collapsed) return null;
  return (
    <button className="icon-btn" title="展开侧边栏" onClick={toggleSidebar}>
      <IconPanel size={15} />
    </button>
  );
}

function HistoryPopup({ messages, taskId, historyId, onClose, onJumpToMessage }: {
  messages: readonly ChatMessage[];
  taskId: string;
  historyId: string | undefined;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}): React.JSX.Element {
  const remote = useHistoryQuestions(historyId ? taskId : undefined, historyId);
  const loaded = messages.filter(message => message.role === "user" && !message.goalContinuation).map(message => ({
    id: message.id,
    text: message.blocks.flatMap(block => block.type === "text" ? [block.text] : []).join(" ").trim(),
  })).filter(question => question.text);
  const localIds = new Set(loaded.map(question => question.id));
  const older = (remote.index ?? []).filter(question => !localIds.has(question.id));
  const questions: TaskUserQuestionDto[] = [...older, ...loaded].reverse();

  return (
    <div className="history-popup">
      <div className="history-popup-title">历史提问 ({questions.length})</div>
      {remote.error && <div role="status">{remote.error}</div>}
      <div className="history-popup-list" onScroll={event => {
        const list = event.currentTarget;
        if (remote.hasMore && !remote.loading && list.scrollHeight - list.scrollTop - list.clientHeight < OLDER_HISTORY_EDGE_PX) remote.loadMore();
      }}>
        {questions.map(question => (
          <button key={question.id} className="history-popup-item" onClick={() => {
            onJumpToMessage(question.id);
            onClose();
          }}>{question.text}</button>
        ))}
      </div>
    </div>
  );
}

type ReadingPosition = { messageId?: string; offset: number; following: boolean };
const readingPositions = new Map<string, ReadingPosition>();

function readPosition(scroller: HTMLElement, following: boolean): ReadingPosition {
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>(".chat-virtual-rows > [role=listitem]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top) return { messageId: row.id.slice(4), offset: rect.top - top, following };
  }
  return { offset: 0, following };
}

export default function ChatView(): React.JSX.Element {
  const task = useActiveTask();
  const [selectedMessageGoal, setSelectedMessageGoal] = useState<ConversationGoalDto>();
  useEffect(() => setSelectedMessageGoal(undefined), [task?.id]);
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
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const tailSpaceRef = useRef<HTMLDivElement>(null);
  const historyAnchorRef = useRef<HTMLDivElement>(null);
  const openedHistoryRef = useRef<string | undefined>(undefined);
  // Only a local submit, not assistant or tool updates, can request a new-turn pin.
  const pendingLocalSendRef = useRef<{ taskId: string; previousUserId: string | null } | null>(null);
  const history = useChatHistory(task);

  useDismissOnClickOutside(historyOpen, () => setHistoryOpen(false), historyAnchorRef);
  /** 诊断弹窗绑定当前任务：切换任务即关闭，避免仍显示上一个任务的记录 */
  useEffect(() => setDiagnosticsOpen(false), [task?.id]);

  const isBotTimeline = Boolean(task?.durable || task?.welcomeMode === "general" || task?.botPendingSubmissions?.length);
  const displayMessages = useMemo(() => {
    const messages = history.messages;
    return !history.loading && isBotTimeline
      ? botMessagePresentation(messages, task?.durable?.pendingInputs, task?.botPendingSubmissions,
        task?.id === DOTS_TASK_ID && Boolean(task.durable?.busy || task.botPendingSubmissions?.some(input => input.submitting))) : messages;
  }, [history.messages, history.loading, isBotTimeline, task?.id, task?.durable?.busy, task?.durable?.pendingInputs, task?.botPendingSubmissions]);
  const dotsSources = task?.id === DOTS_TASK_ID
    ? JSON.stringify(displayMessages.filter(message => message.role === "user").flatMap(message => [message.id, ...(message.inputRequestId ? [message.inputRequestId] : [])]))
    : undefined;
  const dotsDelegations = useDotsDelegations(dotsSources);
  const taskDelivery = useTaskDotsDelivery(task?.id === DOTS_TASK_ID ? undefined : task?.id);
  const hasMessages = displayMessages.length > 0;
  const latestUserMessageId = useMemo(() => latestHumanMessageId(displayMessages), [displayMessages]);
  const activeChatId = task?.id;
  const readingKey = activeChatId && JSON.stringify([activeChatId, task?.durable?.historyId]);
  const turnTarget = useAppStore(s => s.answerRuleTurnTarget);
  const pendingNotificationTarget = useAppStore(s => s.notificationMessageTarget);
  const notificationTarget = pendingNotificationTarget?.taskId === activeChatId ? pendingNotificationTarget : undefined;
  const showLatest = useAppStore(s => task?.id !== undefined && s.chatLatestTarget === task.id);
  const rows = useMemo(() => buildChatMessageRows(task?.id, displayMessages, dotsDelegations.rows, taskDelivery),
    [task?.id, displayMessages, dotsDelegations.rows, taskDelivery]);
  const [floor, setFloor] = useState<{ key: string; rowKey: string | null }>();
  const savedFloor = floor?.key === readingKey ? floor : undefined;
  const recentStart = Math.max(0, rows.length - RECENT_CHAT_ROWS);
  const floorIndex = savedFloor?.rowKey === null ? 0 : rows.findIndex(row => row.key === savedFloor?.rowKey);
  const startIndex = floorIndex < 0 ? recentStart : floorIndex;
  const [historyJump, setHistoryJump] = useState<{ key: string; messageId: string; offset: number }>();
  const pendingJump = historyJump?.key === readingKey ? historyJump : undefined;
  const earlierRequest = useRef<symbol | undefined>(undefined);
  const historyJumpRequest = useRef<symbol | undefined>(undefined);

  useLayoutEffect(() => {
    earlierRequest.current = undefined;
    historyJumpRequest.current = undefined;
  }, [readingKey]);

  useLayoutEffect(() => {
    if (!readingKey || savedFloor || !rows.length || (rows.length < RECENT_CHAT_ROWS && history.before !== undefined)) return;
    setFloor({ key: readingKey, rowKey: rows[recentStart].key });
  }, [readingKey, savedFloor, rows, recentStart, history.before]);

  useEffect(() => {
    if (readingKey && !savedFloor && rows.length < RECENT_CHAT_ROWS && history.before !== undefined) {
      void history.loadEarlier();
    }
  }, [readingKey, savedFloor, rows.length, history.before, history.loadEarlier]);

  const requestEarlier = useCallback(() => {
    if (!readingKey || earlierRequest.current) return;
    if (startIndex > 0) {
      setFloor({ key: readingKey, rowKey: rows[Math.max(0, startIndex - RECENT_CHAT_ROWS)].key });
      return;
    }
    if (history.before === undefined) return;
    const request = Symbol();
    earlierRequest.current = request;
    void history.loadEarlier().then(loaded => {
      if (loaded && earlierRequest.current === request) setFloor({ key: readingKey, rowKey: null });
    }).finally(() => {
      if (earlierRequest.current === request) earlierRequest.current = undefined;
    });
  }, [readingKey, startIndex, rows, history.before, history.loadEarlier]);
  const [unresolvedNotificationAnchor, setUnresolvedNotificationAnchor] = useState<typeof notificationTarget>();
  const turnMessage = useMemo(() => {
    if (notificationTarget) {
      const exact = displayMessages.find(message => message.id === notificationTarget.messageId
        || message.sourceMessageIds?.includes(notificationTarget.messageId)
        || message.dotsDelivery?.deliveryKey === notificationTarget.messageId);
      if (exact && (!notificationTarget.interactionId || exact.interactions?.some(item => item.id === notificationTarget.interactionId))) return exact;
      const matches = displayMessages.filter(message => notificationTarget.interactionId
        ? message.interactions?.some(item => item.id === notificationTarget.interactionId)
        : notificationTarget.toolCallId && message.blocks.some(block =>
          block.type === "tool" && block.toolCall.id === notificationTarget.toolCallId));
      return matches.length === 1 ? matches[0] : exact;
    }
    if (!turnTarget || turnTarget.taskId !== activeChatId) return;
    const index = displayMessages.findIndex(m => m.role === "user" && (m.inputRequestId ?? m.id) === turnTarget.inputId);
    if (index < 0) return;
    const reply = displayMessages[index + 1];
    return reply?.role === "assistant" ? reply : displayMessages[index];
  }, [displayMessages, turnTarget, activeChatId, notificationTarget]);
  const targetId = pendingJump?.messageId ?? turnMessage?.id;
  const targetIndex = targetId ? rows.findIndex(row => row.message.id === targetId) : -1;
  const firstVisibleIndex = targetIndex >= 0 ? Math.min(startIndex, targetIndex) : startIndex;
  const visibleRows = useMemo(() => rows.slice(firstVisibleIndex), [rows, firstVisibleIndex]);
  const [pinRequest, setPinRequest] = useState<{ key: string; id: string }>();
  const pinTarget = pinRequest?.key === readingKey ? pinRequest?.id : undefined;
  const lastMessageId = showLatest || pinTarget ? rows.at(-1)?.message.id : undefined;
  const mountedTargets = useMemo(() => [targetId, pinTarget, lastMessageId], [targetId, pinTarget, lastMessageId]);
  const [searchedTarget, setSearchedTarget] = useState<typeof notificationTarget | typeof turnTarget>();
  const messageTarget = notificationTarget ?? (turnTarget?.taskId === activeChatId ? turnTarget : undefined);
  const canReadEarlier = history.before !== undefined;
  useEffect(() => {
    if (!messageTarget || turnMessage || history.loading || !canReadEarlier || searchedTarget === messageTarget) return;
    let cancelled = false;
    void history.loadEarlier(message => notificationTarget
      ? message.id === notificationTarget.messageId || message.dotsDelivery?.deliveryKey === notificationTarget.messageId
        || message.interactions?.some(item => item.id === notificationTarget.interactionId) === true
        || message.blocks.some(block => block.type === "tool" && block.toolCall.id === notificationTarget.toolCallId)
      : message.role === "user" && (message.inputRequestId ?? message.id) === turnTarget?.inputId)
      .finally(() => { if (!cancelled) setSearchedTarget(messageTarget); });
    return () => { cancelled = true; };
  }, [messageTarget, turnMessage, history.loading, canReadEarlier, history.loadEarlier, notificationTarget, turnTarget, searchedTarget]);
  const clearMessageTarget = () => useAppStore.setState({ answerRuleTurnTarget: undefined, notificationMessageTarget: undefined });

  /* ------------------------------------------------------------------
   * 滚动意图状态机（单一真源 lib/scrollFollow）：
   * - followStateRef 保存完整状态（避免高频 scroll 事件触发重渲染）；
   * - followVisible 仅镜像 follow 翻转，用于「回到底部」按钮显隐。
   * ------------------------------------------------------------------ */
  const followStateRef = useRef<FollowState>(initialFollowState());
  const [followVisible, setFollowVisible] = useState(true);
  /** 程序化滚动防护：置顶写目标（数字）；到达前忽略 scroll 事件 */
  const programmaticTargetRef = useRef<number | null>(null);
  /** 上次记录的 scrollTop（无手势 scroll 事件的方向推断用） */
  const lastScrollTopRef = useRef(0);

  /** 提交状态机转移：ref 保存真源；仅当 follow 翻转时同步镜像给按钮显隐/门控。 */
  const commitFollow = useCallback((next: FollowState): void => {
    const prev = followStateRef.current;
    followStateRef.current = next;
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

  const latestObserverRef = useRef<ResizeObserver | null>(null);
  const stopFollowingLatest = useCallback((): void => {
    latestObserverRef.current?.disconnect();
    latestObserverRef.current = null;
  }, []);
  useLayoutEffect(() => stopFollowingLatest, [readingKey, stopFollowingLatest]);

  const jumpToNode = useCallback((node: HTMLElement | null): void => {
    const el = scrollRef.current;
    if (!el || !node || !el.contains(node)) return;
    stopFollowingLatest();
    commitFollow(onHistoryJump(followStateRef.current));
    applyProgrammaticScrollTop(el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - TURN_TOP_OFFSET);
  }, [applyProgrammaticScrollTop, commitFollow, stopFollowingLatest]);
  const jumpToHistoryQuestion = useCallback(async (messageId: string, offset = TURN_TOP_OFFSET): Promise<void> => {
    if (!readingKey) return;
    const token = Symbol();
    historyJumpRequest.current = token;
    const found = rows.some(row => row.message.id === messageId) || await history.loadEarlier(message => message.id === messageId);
    if (found && historyJumpRequest.current === token) setHistoryJump({ key: readingKey, messageId, offset });
  }, [history.loadEarlier, readingKey, rows]);

  useLayoutEffect(() => {
    if (!pendingJump || !readingKey) return;
    if (targetIndex >= 0 && targetIndex < startIndex) {
      setFloor({ key: readingKey, rowKey: rows[targetIndex].key });
      return;
    }
    return settleChatPlacement(() => {
      const el = scrollRef.current;
      const node = document.getElementById(`msg-${pendingJump.messageId}`);
      if (!el || !node || !el.contains(node)) return;
      stopFollowingLatest();
      commitFollow(onHistoryJump(followStateRef.current));
      const offset = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
      applyProgrammaticScrollTop(el.scrollTop + offset - pendingJump.offset);
      readingPositions.set(readingKey, readPosition(el, false));
    }, () => setHistoryJump(undefined));
  }, [pendingJump, readingKey, targetIndex, startIndex, rows, stopFollowingLatest, commitFollow, applyProgrammaticScrollTop]);

  const pinUserMessageToTop = useCallback(() => {
    if (readingKey && latestUserMessageId) setPinRequest({ key: readingKey, id: latestUserMessageId });
  }, [readingKey, latestUserMessageId]);

  useLayoutEffect(() => {
    if (!pinTarget) return;
    return settleChatPlacement(() => {
      const el = scrollRef.current;
      const spacer = tailSpaceRef.current;
      const node = document.getElementById(`msg-${pinTarget}`);
      if (!el || !spacer || !node || !el.contains(node)) return;
      stopFollowingLatest();
      const viewportTop = el.getBoundingClientRect().top + el.clientTop;
      const position = chatPinPosition({
        scrollTop: el.scrollTop,
        naturalHeight: el.scrollTop + spacer.getBoundingClientRect().top - viewportTop
          + (Number.parseFloat(getComputedStyle(el).paddingBottom) || 0),
        viewportHeight: el.clientHeight,
        anchorOffset: node.getBoundingClientRect().top - viewportTop,
        topInset: TURN_TOP_OFFSET,
      });
      // Keep the reserve stable between explicit placements. Streaming, tool
      // events, and assistant completion do not toggle it or write scrollTop.
      spacer.style.height = `${position.tailSpace}px`;
      commitFollow(onResetForTask(followStateRef.current));
      applyProgrammaticScrollTop(position.top);
    }, () => setPinRequest(undefined));
  }, [applyProgrammaticScrollTop, commitFollow, pinTarget, stopFollowingLatest]);

  const scrollToLatest = useCallback((): void => {
    const el = scrollRef.current;
    const list = messageListRef.current;
    const spacer = tailSpaceRef.current;
    if (!el || !list || !spacer || !readingKey) return;
    stopFollowingLatest();
    spacer.style.height = "0px";
    commitFollow(onResetForTask(followStateRef.current));
    const scrollToEnd = () => {
      applyProgrammaticScrollTop(el.scrollHeight);
      readingPositions.set(readingKey, { offset: 0, following: true });
    };
    scrollToEnd();
    // Delivery rows and attachments can change the height after the first layout.
    const observer = new ResizeObserver(scrollToEnd);
    latestObserverRef.current = observer;
    observer.observe(list);
    observer.observe(el);
  }, [applyProgrammaticScrollTop, commitFollow, readingKey, stopFollowingLatest]);

  useLayoutEffect(() => {
    if (pendingLocalSendRef.current?.taskId !== task?.id) pendingLocalSendRef.current = null;
    if (!readingKey || !hasMessages || history.loading) {
      if (openedHistoryRef.current !== readingKey) openedHistoryRef.current = undefined;
      return;
    }
    const pending = pendingLocalSendRef.current;
    const localQuestionArrived = pending && latestUserMessageId !== null && pending.previousUserId !== latestUserMessageId;
    if (localQuestionArrived) pendingLocalSendRef.current = null;
    const firstOpen = openedHistoryRef.current !== readingKey;
    openedHistoryRef.current = readingKey;
    if (showLatest) {
      useAppStore.setState({ chatLatestTarget: undefined });
      if (!localQuestionArrived && !notificationTarget && turnTarget?.taskId !== task?.id) {
        scrollToLatest();
        return;
      }
    }
    if (firstOpen && !localQuestionArrived) {
      const saved = readingPositions.get(readingKey);
      if (saved?.messageId && !saved.following) {
        void jumpToHistoryQuestion(saved.messageId, saved.offset);
        return;
      }
    }
    if (firstOpen || localQuestionArrived) pinUserMessageToTop();
  }, [task?.id, readingKey, hasMessages, history.loading, latestUserMessageId, showLatest, notificationTarget, turnTarget?.taskId,
    pinUserMessageToTop, scrollToLatest, jumpToHistoryQuestion]);

  useLayoutEffect(() => {
    if (!turnMessage || history.loading) return;
    const node = document.getElementById(`msg-${turnMessage.id}`);
    if (!node || !scrollRef.current?.contains(node)) return;
    const interaction = notificationTarget?.interactionId && Array.from(node.querySelectorAll<HTMLElement>("[data-interaction-id]"))
      .find(element => element.dataset.interactionId === notificationTarget.interactionId);
    const tool = notificationTarget?.toolCallId && Array.from(node.querySelectorAll<HTMLElement>("[data-tool-call-id]"))
      .find(element => element.dataset.toolCallId === notificationTarget.toolCallId);
    const anchor = interaction || tool;
    if (notificationTarget && (notificationTarget.interactionId || notificationTarget.toolCallId) && !anchor) {
      setUnresolvedNotificationAnchor(notificationTarget);
      return;
    }
    if (readingKey && targetIndex >= 0 && targetIndex < startIndex) setFloor({ key: readingKey, rowKey: rows[targetIndex].key });
    const focus = anchor || node;
    if (focus instanceof HTMLDetailsElement) focus.open = true;
    jumpToNode(focus);
    focus.tabIndex = -1;
    focus.addEventListener("blur", () => focus.removeAttribute("tabindex"), { once: true });
    focus.focus({ preventScroll: true });
    clearMessageTarget();
  }, [turnMessage, history.loading, jumpToNode, notificationTarget, readingKey, targetIndex, startIndex, rows]);

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
      if (delta < 0 && el.scrollTop <= OLDER_HISTORY_EDGE_PX) requestEarlier();
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
        stopFollowingLatest();
        commitFollow(delta < 0 ? onUserScrollUp(s) : onUserScrollDown(s));
      }
      const next = onFollowScroll(followStateRef.current, bottomDistance(), delta);
      if (next.follow && next.direction === "down") {
        // 向下手势已解析（落到底部阈值内）：清除方向锁，恢复自动跟随
        commitFollow({ ...next, direction: null });
      } else {
        commitFollow(next);
      }
      if (readingKey && !history.loading) {
        readingPositions.set(readingKey, readPosition(el, next.follow));
      }
    };
    const markWheelIntent = (event: WheelEvent): void => {
      // 用户手势打断未决的程序滚动目标
      if (event.deltaY !== 0) {
        stopFollowingLatest();
        if (pinTarget) setPinRequest(undefined);
        if (pendingJump) setHistoryJump(undefined);
      }
      programmaticTargetRef.current = null;
      if (event.deltaY < 0) {
        // P2-1：wheel 上滚只登记候选（触底回弹/惯性零位移不锁存）；
        // 实际向上位移由 handleScroll → onFollowScroll(scrollDelta<0) 确认锁存。
        commitFollow(onWheelUpCandidate(followStateRef.current));
        if (element.scrollTop <= OLDER_HISTORY_EDGE_PX) requestEarlier();
      } else if (event.deltaY > 0) {
        // 向下意图：清除 wheel 上滚候选（用户实际在向下滚）并锁存方向
        commitFollow(onUserScrollDown(followStateRef.current));
      }
    };
    const markPointerIntent = (event: PointerEvent): void => {
      // 滚动条拖动与触摸滚动：目标为容器本身，或任何触摸指针（触摸滚动任意子元素）
      if (event.target !== element && event.pointerType !== "touch") return;
      if (pinTarget) setPinRequest(undefined);
      if (pendingJump) setHistoryJump(undefined);
      stopFollowingLatest();
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
      if (pinTarget) setPinRequest(undefined);
      if (pendingJump) setHistoryJump(undefined);
      stopFollowingLatest();
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
  }, [readingKey, hasMessages, history.loading, commitFollow, bottomDistance, stopFollowingLatest, requestEarlier, pinTarget, pendingJump]);

  // 无选中任务，或新建空任务（尚无 session）→ 首页 Hero
  // 有 sessionFile 但 messages 暂空 → 恢复中，进聊天区（避免被当成「打不开」）
  const boundProjectId = task?.projectId ?? draftProjectId;
  const subagentView = useAppStore((s) => s.subagentView);
  const sidePanelButton = <button className={`icon-btn ${panelOpen ? "toggled" : ""}`} title={panelOpen ? "关闭侧栏" : "打开概览"}
    onClick={() => (panelOpen ? closePanel() : openSidePanel())}><IconPanelRight size={15} /></button>;

  // 子代理对话页：共用同一个聊天外壳（同一批消息组件/输入外壳），只是数据源换成子会话。
  // 放在所有 hook 之后，避免条件返回改变 hook 顺序。
  if (task && subagentView && subagentView.taskId === task.id) {
    return <SubagentChatView taskId={task.id} subagentId={subagentView.subagentId} />;
  }

  // Admission and errors remain visible before the first native message arrives.
  const isDots = task?.id === DOTS_TASK_ID;
  const dotsHeader = (
    <div className="chat-header task-chat-header">
      <CollapsedSidebarActions />
      <IconDots size={22} />
      <div className="chat-header-title">MyBuddy Dots</div>
      <DotsAllTasks />
    </div>
  );
  if (!task || (!isDots && task.welcomeMode !== "general" && !hasMessages && !task.sessionFile && !task.durable && !task.botInputError)) {
    const showHeroHeader = Boolean(task || sidebarCollapsed || boundProjectId || draftSpaceId);
    return (
      <>
        {showHeroHeader && (
          <div className="chat-header hero-header">
            <CollapsedSidebarActions />
            {boundProjectId && <ChatProjectCrumb projectId={boundProjectId} />}
            {draftSpaceId ? <WorkspaceCrumb spaceId={draftSpaceId} /> : null}
            <div className="chat-header-sub" />
            {task && <ConversationGoalChip key={task.id} taskId={task.id} goal={task.activeGoal} />}
            {task && sidePanelButton}
          </div>
        )}
        <HomeHero />
      </>
    );
  }

  const taskMode: WelcomeMode =
    task.welcomeMode === "working" || task.welcomeMode === "general" || task.welcomeMode === "coding"
      ? task.welcomeMode
      : "coding";

  if (!hasMessages) {
    return (
      <div className="chat-column task-ambient" data-mode={taskMode}>
        {isDots ? dotsHeader : <div className="chat-header task-chat-header">
          <CollapsedSidebarActions />
          {task.projectId && <ChatProjectCrumb projectId={task.projectId} trailingSlash />}
          <WorkspaceCrumb spaceId={task.spaceId ?? null} />
          <div className="chat-header-title" title={task.title || undefined}>{task.title || "任务"}</div>
          <ConversationGoalChip key={task.id} taskId={task.id} goal={task.activeGoal} />
          <ConversationBranchChip />
          {/* 子代理查看（数据源与侧栏概览同一个 hook）：取代原来的场景 chip */}
          <SubagentRunsChip taskId={task.id} />
          {taskExpert && (
            <span className="chat-expert-chip" title={`专家：${taskExpert.name}`}>
              <span className="chat-expert-chip-symbol" aria-hidden="true">
                {taskExpert.emoji || <UiIcon name="expert" size="1em" />}
              </span>
              <span className="chat-expert-chip-label">{taskExpert.name}</span>
            </span>
          )}
          <RuntimeStatusChips modePresetId={task.modePresetId} />
          <div className="input-spacer" />
          {sidePanelButton}
        </div>}
        <div className="chat-scroll">
          {isDots && dotsDelegations.error && <div role="alert">{dotsDelegations.error}</div>}
          {!isDots && !task.historyError && !history.error &&
          <div className="empty-block" style={{ margin: "48px auto" }}>
            <div className="empty-block-title">{!history.loading && (task.durable || task.welcomeMode === "general") ? "会话" : "正在加载历史对话…"}</div>
            <div style={{ fontSize: 12.5 }}>{!history.loading && (task.durable || task.welcomeMode === "general") ? "消息接受后将显示在这里" : "正在从会话文件恢复消息"}</div>
          </div>}
          {(task.historyError || history.error) &&
          <div className="empty-block" style={{ margin: "48px auto" }} role="alert" data-testid="history-error">
            <div className="empty-block-title">会话记录打不开</div>
            <div style={{ fontSize: 12.5 }}>{history.error ?? task.historyError}</div>
            {history.error && <button type="button" onClick={history.retry}>重试</button>}
          </div>}
        </div>
        {task.botInputError && <div className="durable-bot-state" role="alert">{task.botInputError}</div>}
        <SessionHistoryRecoveryNotice recovery={task.sessionRecovery} />
        <TaskModelRecoveryNotice recovery={task.modelRecovery} />
        {task.welcomeMode !== "general" && <TaskRecoveryNotice key={task.id} taskId={task.id} projectId={task.projectId} refreshKey="history" />}
        {/* 空会话没有消息可撑高：Dots 用首页同款窄栏摆放输入框，其余任务保持原位置 */}
        {isDots
          ? <div className="dots-hero"><ChatInput variant="chat" /></div>
          : <ChatInput variant="chat" />}
      </div>
    );
  }

  const commitTitle = (): void => {
    const next = titleDraft.trim().slice(0, TASK_TITLE_MAX_CHARS);
    if (next) renameTask(task.id, next);
    setEditingTitle(false);
  };

  return (
    <div className="chat-column task-ambient" data-mode={taskMode}>
      {isDots ? dotsHeader : <div className="chat-header task-chat-header">
        <CollapsedSidebarActions />
        {task.projectId && <ChatProjectCrumb projectId={task.projectId} trailingSlash />}
        <WorkspaceCrumb spaceId={task.spaceId ?? null} />
        <div className="chat-header-title">
          {editingTitle ? (
            <span className="task-title-edit">
              <input
                autoFocus
                aria-label={`任务名，最多 ${TASK_TITLE_MAX_CHARS} 字`}
                maxLength={TASK_TITLE_MAX_CHARS}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => e.key === "Enter" && commitTitle()}
              />
              <span className={`task-title-count${titleDraft.length > TASK_TITLE_MAX_CHARS ? " is-over" : ""}`} aria-hidden="true">
                {titleDraft.length}/{TASK_TITLE_MAX_CHARS}
              </span>
            </span>
          ) : (
            <span
              onDoubleClick={() => {
                setTitleDraft(task.title);
                setEditingTitle(true);
              }}
              title={task.title ? `${task.title}\n双击重命名` : "双击重命名"}
            >
              {task.title}
            </span>
          )}
        </div>
        <div className="chat-header-sub" />
        <ConversationGoalChip key={task.id} taskId={task.id} goal={task.activeGoal}
          viewGoal={selectedMessageGoal?.taskId === task.id ? selectedMessageGoal : undefined} />
        <ConversationBranchChip />
        {/* 子代理查看（数据源与侧栏概览同一个 hook）：取代原来的场景 chip */}
        <SubagentRunsChip taskId={task.id} />
        {taskExpert && (
          <span className="chat-expert-chip" title={`专家：${taskExpert.name}`}>
            <span className="chat-expert-chip-symbol" aria-hidden="true">
              {taskExpert.emoji || <UiIcon name="expert" size="1em" />}
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
              messages={displayMessages}
              taskId={task.id}
              historyId={history.before === undefined ? undefined : task.durable?.historyId}
              onClose={() => setHistoryOpen(false)}
              onJumpToMessage={jumpToHistoryQuestion}
            />
          )}
        </div>
        <TaskDiagnosticsButton open={diagnosticsOpen} onClick={() => setDiagnosticsOpen(true)} />
        {sidePanelButton}
      </div>}
      {diagnosticsOpen && (
        <TaskDiagnosticsDialog taskId={task.id} onClose={() => setDiagnosticsOpen(false)} />
      )}


      <div className="chat-viewport">
        <div className="message-scroll" ref={scrollRef}>
          {(messageTarget && !history.loading && !turnMessage && (searchedTarget === messageTarget || history.before === undefined)
            || notificationTarget && unresolvedNotificationAnchor === notificationTarget) && (
            <div className="conv-branch-error" role="status">
              {turnMessage ? "指定的工具或交互还未出现在这条消息中。" : "当前对话历史中找不到指定的消息。"}
              <button type="button" onClick={clearMessageTarget}>关闭</button>
            </div>
          )}
          {task.historyError && <div className="conv-branch-error" role="alert">{task.historyError}</div>}
          {history.error && <div className="conv-branch-error" role="alert">{history.error} <button type="button" onClick={history.retry}>重试</button></div>}
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
          {/* 静态兄弟元素不要带 key：两个兄弟同时用 task.id 会让 React 复用同一
              fiber，把整条消息列表渲染两遍（看起来像「消息自己重复刷新」）。 */}
          {isDots && dotsDelegations.error && <div role="alert">{dotsDelegations.error}</div>}
          <ChatMessageList
            key={readingKey}
            listRef={messageListRef}
            scrollRef={scrollRef}
            rows={visibleRows}
            mountedTargets={mountedTargets}
            writeScrollTop={applyProgrammaticScrollTop}
            onGoalCreated={setSelectedMessageGoal}
            toolFocusMessageId={notificationTarget?.toolCallId ? turnMessage?.id : undefined}
            taskId={task.id}
            messages={displayMessages}
            artifacts={artifacts}
            visibleArtifacts={visibleArtifacts}
          />
          <div ref={tailSpaceRef} className="chat-pin-tail-space" aria-hidden="true" />
        </div>
        {/* 用户接管滚动（上拉阅读历史）时出现；点击 = 显式「回到底部」动作。
            位于 chat viewport overlay 层（非滚动容器内）：消息怎么滚，
            按钮视觉位置都不移动；固定在 composer 上方、与内容列对齐。 */}
        {!followVisible && (
          <button
            type="button"
            className="jump-to-bottom"
            title="回到底部"
            onMouseDown={(e) => e.preventDefault()}
            onClick={isDots ? scrollToLatest : pinUserMessageToTop}
          >
            <IconChevronDown size={14} />
            回到底部
          </button>
        )}
      </div>

      <SessionHistoryRecoveryNotice recovery={task.sessionRecovery} />
      {task.id === DOTS_TASK_ID && <ChatAnswerRuleDialog key={task.id} taskId={task.id} />}
      <TaskModelRecoveryNotice recovery={task.modelRecovery} />
      {task.welcomeMode !== "general" && <TaskRecoveryNotice key={task.id} taskId={task.id} projectId={task.projectId} refreshKey={`${task.messages.length}:${task.messages.some((message) => message.streaming)}:${task.messages.filter((message) => message.generateError).length}`} />}
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
          pendingLocalSendRef.current = { taskId: task.id, previousUserId: latestUserMessageId };
        }}
      />
    </div>
  );
}
