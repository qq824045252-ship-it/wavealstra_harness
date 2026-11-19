import { DEFAULT_WELCOME_MODE } from "@shared/mode-profile";
import TaskRecoveryNotice from "./TaskRecoveryNotice";
import SessionHistoryRecoveryNotice from "./SessionHistoryRecoveryNotice";
import TaskModelRecoveryNotice from "./TaskModelRecoveryNotice";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useActiveTask, useActiveTaskArtifacts, useVisibleTaskArtifacts, useAppStore } from "@/store/appStore";
import type { Artifact, ChatMessage, Space } from "@/types";
import MessageItem from "./MessageItem";
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
  IconAlert,
  IconPanel,
  IconX,
} from "@/components/common/icons";
import type { McpServerDto, ModePresetDto, WelcomeMode } from "@shared/agent-ipc";
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
import { useFullTaskHistory } from "./useFullTaskHistory";
import { chatPinPosition, latestHumanMessageId } from "@/lib/chatPinPosition";

/** 新一轮用户消息置顶时距滚动容器顶的留白 */
const TURN_TOP_OFFSET = 8;

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
  messages,
  onClose,
  onJumpToMessage,
}: {
  messages: readonly ChatMessage[];
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}): React.JSX.Element | null {
  const questions = messages
    // Host auto-continuations are not questions the user asked.
    .filter((m) => m.role === "user" && !m.goalContinuation)
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

function MessageList({ taskId, messages, artifacts, visibleArtifacts }: {
  taskId: string;
  messages: readonly ChatMessage[];
  artifacts: Artifact[];
  visibleArtifacts: Artifact[];
}): React.JSX.Element {
  let precedingUser: ChatMessage | undefined;
  return (
    <div className="message-list">
      {messages.map((msg) => {
        if (msg.role === "user") precedingUser = msg;
        return (
        <div key={msg.presentationKey ?? msg.id} id={`msg-${msg.id}`}>
          <MessageItem message={msg} taskId={taskId} sourceQuestion={msg.role === "assistant" ? precedingUser : undefined}
            artifacts={artifacts} visibleArtifacts={visibleArtifacts} />
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
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tailSpaceRef = useRef<HTMLDivElement>(null);
  const historyAnchorRef = useRef<HTMLDivElement>(null);
  const openedHistoryRef = useRef<string | undefined>(undefined);
  // Only a local submit, not assistant or tool updates, can request a new-turn pin.
  const pendingLocalSendRef = useRef<{ taskId: string; previousUserId: string | null } | null>(null);
  const fullHistory = useFullTaskHistory(task);

  useDismissOnClickOutside(historyOpen, () => setHistoryOpen(false), historyAnchorRef);
  /** 诊断弹窗绑定当前任务：切换任务即关闭，避免仍显示上一个任务的记录 */
  useEffect(() => setDiagnosticsOpen(false), [task?.id]);

  const isBotTimeline = Boolean(task?.durable || task?.welcomeMode === "general" || task?.botPendingSubmissions?.length);
  const displayMessages = useMemo(() => {
    const messages = fullHistory.messages;
    return !fullHistory.loading && isBotTimeline
      ? botMessagePresentation(messages, task?.durable?.pendingInputs, task?.botPendingSubmissions) : messages;
  }, [fullHistory.messages, fullHistory.loading, isBotTimeline, task?.durable?.pendingInputs, task?.botPendingSubmissions]);
  const hasMessages = displayMessages.length > 0;
  const latestUserMessageId = useMemo(() => latestHumanMessageId(displayMessages), [displayMessages]);
  const activeChatId = task?.id;

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

  const jumpToHistoryQuestion = useCallback((messageId: string): void => {
    const el = scrollRef.current;
    const node = document.getElementById(`msg-${messageId}`);
    if (!el || !node || !el.contains(node)) return;
    commitFollow(onHistoryJump(followStateRef.current));
    applyProgrammaticScrollTop(el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - TURN_TOP_OFFSET);
  }, [applyProgrammaticScrollTop, commitFollow]);

  const pinUserMessageToTop = useCallback((): void => {
    const el = scrollRef.current;
    const spacer = tailSpaceRef.current;
    const node = latestUserMessageId ? document.getElementById(`msg-${latestUserMessageId}`) : null;
    if (!el || !spacer || !node || !el.contains(node)) return;
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
  }, [applyProgrammaticScrollTop, commitFollow, latestUserMessageId]);

  useLayoutEffect(() => {
    if (pendingLocalSendRef.current?.taskId !== task?.id) pendingLocalSendRef.current = null;
    if (!activeChatId || !hasMessages || fullHistory.loading) {
      if (openedHistoryRef.current !== activeChatId) openedHistoryRef.current = undefined;
      return;
    }
    const pending = pendingLocalSendRef.current;
    const localQuestionArrived = pending && latestUserMessageId !== null && pending.previousUserId !== latestUserMessageId;
    if (localQuestionArrived) pendingLocalSendRef.current = null;
    const firstOpen = openedHistoryRef.current !== activeChatId;
    openedHistoryRef.current = activeChatId;
    if (firstOpen || localQuestionArrived) pinUserMessageToTop();
  }, [task?.id, activeChatId, hasMessages, fullHistory.loading, latestUserMessageId, pinUserMessageToTop]);

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
  }, [task?.id, hasMessages, commitFollow, bottomDistance]);

  // 无选中任务，或新建空任务（尚无 session）→ 首页 Hero
  // 有 sessionFile 但 messages 暂空 → 恢复中，进聊天区（避免被当成「打不开」）
  const boundProjectId = task?.projectId ?? draftProjectId;
  const subagentView = useAppStore((s) => s.subagentView);
  const sidePanelButton = <button className={`icon-btn ${panelOpen ? "toggled" : ""}`} title={panelOpen ? "关闭侧栏" : "打开概览"}
    onClick={() => (panelOpen ? closePanel() : openSidePanel())}><IconPanel size={15} /></button>;

  // 子代理对话页：共用同一个聊天外壳（同一批消息组件/输入外壳），只是数据源换成子会话。
  // 放在所有 hook 之后，避免条件返回改变 hook 顺序。
  if (task && subagentView && subagentView.taskId === task.id) {
    return <SubagentChatView taskId={task.id} subagentId={subagentView.subagentId} />;
  }

  // Admission and errors remain visible before the first native message arrives.
  if (!task || (task.welcomeMode !== "general" && !hasMessages && !task.sessionFile && !task.durable && !task.botInputError)) {
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
    task.welcomeMode === "working" || task.welcomeMode === "general" || task.welcomeMode === "coding"
      ? task.welcomeMode
      : "coding";

  if (!hasMessages) {
    return (
      <div className="chat-column task-ambient" data-mode={taskMode}>
        <div className="chat-header task-chat-header">
          <CollapsedSidebarActions />
          {task.projectId && <ChatProjectCrumb projectId={task.projectId} trailingSlash />}
          <WorkspaceCrumb spaceId={task.spaceId ?? null} />
          <div className="chat-header-title">{task.title || "任务"}</div>
          {task.welcomeMode !== "general" && <ConversationGoalChip taskId={task.id} goal={task.activeGoal} />}
          <ConversationBranchChip />
          {/* 子代理查看（数据源与侧栏概览同一个 hook）：取代原来的场景 chip */}
          <SubagentRunsChip taskId={task.id} />
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
          {!task.historyError && !fullHistory.error &&
          <div className="empty-block" style={{ margin: "48px auto" }}>
            <div className="empty-block-title">{!fullHistory.loading && (task.durable || task.welcomeMode === "general") ? "会话" : "正在加载历史对话…"}</div>
            <div style={{ fontSize: 12.5 }}>{!fullHistory.loading && (task.durable || task.welcomeMode === "general") ? "消息接受后将显示在这里" : "正在从会话文件恢复消息"}</div>
          </div>}
          {(task.historyError || fullHistory.error) &&
          <div className="empty-block" style={{ margin: "48px auto" }} role="alert" data-testid="history-error">
            <div className="empty-block-title">会话记录打不开</div>
            <div style={{ fontSize: 12.5 }}>{fullHistory.error ?? task.historyError}</div>
            {fullHistory.error && <button type="button" onClick={fullHistory.retry}>重试</button>}
          </div>}
        </div>
        {task.botInputError && <div className="durable-bot-state" role="alert">{task.botInputError}</div>}
        <SessionHistoryRecoveryNotice recovery={task.sessionRecovery} />
        <TaskModelRecoveryNotice recovery={task.modelRecovery} />
        {task.welcomeMode !== "general" && <TaskRecoveryNotice key={task.id} taskId={task.id} projectId={task.projectId} refreshKey="history" />}
        <ChatInput variant="chat" />
      </div>
    );
  }

  const commitTitle = (): void => {
    if (titleDraft.trim()) renameTask(task.id, titleDraft.trim());
    setEditingTitle(false);
  };

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
        {task.welcomeMode !== "general" && <ConversationGoalChip taskId={task.id} goal={task.activeGoal} />}
        <ConversationBranchChip />
        {/* 子代理查看（数据源与侧栏概览同一个 hook）：取代原来的场景 chip */}
        <SubagentRunsChip taskId={task.id} />
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
              messages={displayMessages}
              onClose={() => setHistoryOpen(false)}
              onJumpToMessage={jumpToHistoryQuestion}
            />
          )}
        </div>
        <TaskDiagnosticsButton open={diagnosticsOpen} onClick={() => setDiagnosticsOpen(true)} />
        {sidePanelButton}
      </div>
      {diagnosticsOpen && (
        <TaskDiagnosticsDialog taskId={task.id} onClose={() => setDiagnosticsOpen(false)} />
      )}


      <div className="chat-viewport">
        <div className="message-scroll" ref={scrollRef}>
          {task.historyError && <div className="conv-branch-error" role="alert">{task.historyError}</div>}
          {fullHistory.error && <div className="conv-branch-error" role="alert">{fullHistory.error} <button type="button" onClick={fullHistory.retry}>重试</button></div>}
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
          <MessageList
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
            onClick={pinUserMessageToTop}
          >
            <IconChevronDown size={14} />
            回到底部
          </button>
        )}
      </div>

      <SessionHistoryRecoveryNotice recovery={task.sessionRecovery} />
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
