import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ChatMessage } from "@/types";
import type { Artifact } from "@/types";
import { clockTime, nonEmptyFinalTextBlocks, useAppStore } from "@/store/appStore";
import { resolveTaskFileChanges } from "@/lib/taskFileChanges";
import { stripInjectedUserPromptTail, userPromptDisplayText } from "@shared/user-prompt-display";
import { selectionLabelsFromPrompt } from "@shared/selection-display";
import { requestUserInputDisplayText } from "@shared/request-user-input-fallback";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { taskHasActiveExecution } from "@/utils/taskFilters";
import { ArtifactChipRow, FileBadge } from "@/components/common/FileBadge";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import ExecutionTimeline from "./ExecutionTimeline";
import MessageBlockView from "./MessageBlockView";
import { ChatImageScope, MessageImages } from "./ChatImage";
import { ConversationInteractionCard } from "./ConversationRuntimeCards";
import {
  IconCopy,
  IconBlocks,
  IconBot,
  IconPiLogo,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconGitBranch,
  IconLink,
  IconMore,
  IconPencil,
  IconRefresh,
  IconSparkles,
  IconTarget,
  IconThumbsDown,
  IconThumbsUp,
  IconZap,
  IconCheck,
  IconList,
} from "@/components/common/icons";

interface Props {
  message: ChatMessage;
  /** Only task chat supplies a local image scope; Gateway/BTW must not inherit activeTaskId. */
  taskId?: string;
  artifacts?: Artifact[];
  /** 与产物面板同一套可见列表：芯片与「查看所有产物」都按场景黑白名单过滤 */
  visibleArtifacts?: Artifact[];
  /**
   * BTW 面板内渲染：隐藏任务级产物/变更入口与重新生成/分享等主任务操作，
   * 数据源仍是 BTW 自己的临时消息集合（与主任务管道无任何写入关系）。
   */
  btw?: boolean;
}

/** 超过该字符数默认折叠（长总结/大表一次输出） */
const COLLAPSE_CHAR_THRESHOLD = 480;
/** 折叠时最大可视高度（约 4 行正文，避免气泡仍占半屏） */
const COLLAPSE_MAX_HEIGHT_PX = 96;

const EMPTY_ARTIFACTS: Artifact[] = [];

/**
 * 从完整 prompt 抽出技能 / MCP / 连接器名（历史恢复用；当前会话优先读 message 字段）。
 */
function parseAttachedMetaFromPrompt(raw: string): {
  skillCommands: string[];
  mcpNames: string[];
  connectorNames: string[];
} {
  let text = stripInjectedUserPromptTail(raw);
  if (!text) return { skillCommands: [], mcpNames: [], connectorNames: [] };

  const mcpNames: string[] = [];
  for (const m of text.matchAll(/【使用\s*MCP\s*[：:]([^】]*)】/g)) {
    for (const name of m[1]!.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean)) {
      if (!mcpNames.includes(name)) mcpNames.push(name);
    }
  }
  const connectorNames: string[] = [];
  for (const m of text.matchAll(/【使用连接器[：:]([^】]*)】/g)) {
    for (const part of m[1]!.split(/[;；]/).map((s) => s.trim()).filter(Boolean)) {
      const name = part.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim();
      if (name && !connectorNames.includes(name)) connectorNames.push(name);
    }
  }

  text = text
    .replace(/\n*<!-- mybuddy:reference-context -->[\s\S]*?<!-- \/mybuddy:reference-context -->/g, "")
    .replace(/\n*## 引用任务：[\s\S]*$/g, "")
    .replace(/\n*## 引用文件：[\s\S]*$/g, "")
    .replace(/\n*## 用户附带的终端上下文[\s\S]*$/g, "")
    .replace(/【使用\s*MCP\s*[：:][^】]*】/g, "")
    .replace(/【使用连接器[：:][^】]*】/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const skillCommands: string[] = [];
  let rest = text;
  while (true) {
    const m = rest.match(/^\/([^\s/]+)(?:\s+|$)/);
    if (!m) break;
    skillCommands.push(m[1]!);
    rest = rest.slice(m[0].length).trim();
  }
  return { skillCommands, mcpNames, connectorNames };
}

/**
 * 用户气泡只展示真实说明文字：
 * 去掉注入的 Memory/附件/终端块、/skill 前缀、【使用 MCP：…】，并保留用户换行。
 */
function userDisplayText(raw: string): string {
  return userPromptDisplayText(raw);
}

/** 从历史 prompt 文本解析终端上下文摘要（发送时主进程 append 的块） */
export function parseTerminalContextFromPrompt(raw: string): {
  source: "selection" | "recent-output";
  charCount: number;
  preview?: string;
} | undefined {
  const m = /## 用户附带的终端上下文（(选中文本|最近输出)/.exec(raw);
  if (!m) return undefined;
  const source = m[1] === "选中文本" ? "selection" : "recent-output";
  const fence = /```text\n([\s\S]*?)\n```/.exec(raw.slice(m.index));
  const body = (fence?.[1] ?? "").trim();
  if (!body) return { source, charCount: 0 };
  return {
    source,
    charCount: body.length,
    preview: body.slice(0, 240),
  };
}

/** 附件展示用短文件名，完整路径放 title */
function attachmentLabel(att: Attachment): string {
  const base = att.name?.trim();
  if (base && !/[\\/]/.test(base)) return base;
  const src = (att.path || att.name || "").trim();
  if (!src) return "文件";
  const parts = src.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || src;
}

/** 复制内容：优先最终答复的 Markdown 原文（不含思考过程）；无最终答复时退回时间线正文 */
function assistantCopyText(message: ChatMessage): string {
  const hasStructuredInteraction = (message.interactions?.length ?? 0) > 0;
  const finalText = (message.finalBlocks ?? [])
    .filter((b) => b.type === "text")
    .map((b) => hasStructuredInteraction ? requestUserInputDisplayText(b.text, false) : b.text)
    .join("\n")
    .trim();
  if (finalText) return finalText;
  // 思考文本 inline 规范化，不依赖外部函数
  const normalize = (t: string): string => {
    if (!t) return t;
    return t.replace(/\s+/gu, " ").trim();
  };
  return (message.blocks ?? [])
    .filter((b) => b.type === "text" || b.type === "thinking")
    .map((b) => (b.type === "thinking" ? normalize(b.text) : b.text))
    .join("\n")
    .trim();
}

type CopyState = "idle" | "copied" | "failed" | "empty";

const COPY_FEEDBACK_MS = 1800;

/** 长文自动折叠：默认收起，底部可展开 */
function CollapsibleBody({
  textLength,
  streaming,
  children,
}: {
  textLength: number;
  streaming?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(textLength >= COLLAPSE_CHAR_THRESHOLD);
  const [expanded, setExpanded] = useState(false);

  // 流式结束或内容变化后，用实际高度判定是否需要折叠
  useLayoutEffect(() => {
    if (streaming) {
      setOverflows(false);
      setExpanded(true);
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    const measure = (): void => {
      const tall = el.scrollHeight > COLLAPSE_MAX_HEIGHT_PX + 16;
      const long = textLength >= COLLAPSE_CHAR_THRESHOLD;
      setOverflows(tall || long);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [textLength, streaming, children]);

  // 新长文默认折叠（不在 streaming）
  useEffect(() => {
    if (streaming) return;
    if (textLength >= COLLAPSE_CHAR_THRESHOLD) setExpanded(false);
  }, [textLength, streaming]);

  const collapsed = overflows && !expanded && !streaming;

  return (
    <div className={`msg-collapse${collapsed ? " is-collapsed" : ""}${overflows ? " can-collapse" : ""}`}>
      <div
        ref={bodyRef}
        className="msg-collapse-body"
        style={collapsed ? { maxHeight: COLLAPSE_MAX_HEIGHT_PX } : undefined}
      >
        {children}
      </div>
      {overflows && !streaming && (
        <button
          type="button"
          className="msg-collapse-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              收起 <IconChevronUp size={14} />
            </>
          ) : (
            <>
              展开全部 <IconChevronDown size={14} />
            </>
          )}
        </button>
      )}
    </div>
  );
}

/** 底部操作：复制 / 导入到输入框 / 更多 */
function MessageActionBar({
  copyText,
  moreItems,
  importable = true,
}: {
  copyText: string;
  moreItems?: Array<{ label: string; onClick: () => void; danger?: boolean }>;
  /** BTW 面板内隐藏「导入到输入框」（该操作语义属于主 Composer） */
  importable?: boolean;
}): React.JSX.Element {
  const fillComposer = useAppStore((s) => s.fillComposer);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [moreOpen, setMoreOpen] = useState(false);
  const moreAnchorRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<number | null>(null);

  useDismissOnClickOutside(moreOpen, () => setMoreOpen(false), moreAnchorRef);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const onCopy = async (): Promise<void> => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    if (!copyText.trim()) {
      setCopyState("empty");
      copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
      return;
    }
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
  };

  const onImport = (): void => {
    if (!copyText.trim()) return;
    fillComposer(copyText);
  };

  return (
    <div className="msg-action-bar">
      <button
        type="button"
        className={`msg-action-btn${copyState === "copied" ? " is-copied" : ""}`}
        onClick={() => void onCopy()}
        aria-label={
          copyState === "copied"
            ? "已复制"
            : copyState === "failed"
              ? "复制失败"
              : copyState === "empty"
                ? "没有可复制的内容"
                : "复制"
        }
        title={
          copyState === "copied"
            ? "已复制"
            : copyState === "failed"
              ? "复制失败"
              : copyState === "empty"
                ? "没有可复制的内容"
                : "复制"
        }
      >
        {copyState === "copied" ? <IconCheck size={15} /> : <IconCopy size={15} />}
      </button>
      <button
        type="button"
        className="msg-action-btn"
        onClick={onImport}
        aria-label="导入到输入框"
        title="导入到输入框"
        disabled={!copyText.trim()}
      >
        <IconPencil size={15} />
      </button>
      {importable === false && (!moreItems || moreItems.length === 0) ? null : (
        <div className="msg-action-more" ref={moreAnchorRef}>
          <button
            type="button"
            className={`msg-action-btn${moreOpen ? " is-open" : ""}`}
            onClick={() => setMoreOpen((v) => !v)}
            aria-label="更多"
            title="更多"
            aria-expanded={moreOpen}
            aria-haspopup="menu"
          >
            <IconMore size={15} />
          </button>
          {moreOpen && (
            <div className="msg-action-more-menu" role="menu">
              {(moreItems ?? []).map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`msg-action-more-item${item.danger ? " is-danger" : ""}`}
                  onClick={() => {
                    setMoreOpen(false);
                    item.onClick();
                  }}
                >
                  {item.label}
                </button>
              ))}
              {(!moreItems || moreItems.length === 0) && (
                <div className="msg-action-more-empty">暂无更多操作</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskReferenceNotice({
  references,
}: {
  references: NonNullable<ChatMessage["taskReferences"]>;
}): React.JSX.Element {
  return (
    <div className="user-task-references">
      <div className="user-task-references-title">
        <IconList size={13} /> 已应用任务
      </div>
      {references.map((reference, index) => (
        <div
          key={reference.taskId ?? `${reference.title}-${index}`}
          className="user-task-reference-item"
        >
          <div className="user-task-reference-name">{reference.title || "未命名任务"}</div>
          {reference.spaceName && (
            <div className="user-task-reference-space">来源空间：{reference.spaceName}</div>
          )}
          {(reference.files ?? []).length > 0 && (
            <div className="user-task-reference-files">
              <span className="user-task-reference-files-label">引用文件：</span>
              <div className="user-task-reference-file-list">
                {(reference.files ?? []).map((file, fileIndex) => (
                  <span
                    key={file.id || `${file.name}-${fileIndex}`}
                    className="user-task-reference-file"
                    title={file.path || file.name}
                  >
                    <FileBadge name={file.name} size={14} />
                    <span>{file.name}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MessageItem({ message, taskId, artifacts = EMPTY_ARTIFACTS, visibleArtifacts, btw = false }: Props): React.JSX.Element {
  const showAllArtifacts = useAppStore((s) => s.showAllArtifacts);
  const openLocalAbsoluteFile = useAppStore((s) => s.openLocalAbsoluteFile);
  const openWorkspaceFile = useAppStore((s) => s.openWorkspaceFile);
  const showAllChanges = useAppStore((s) => s.showAllChanges);
  const currentTask = useAppStore((s) => s.tasks.find((t) => t.id === (taskId || s.activeTaskId)));
  /** 任务级变更数：与右侧栏代码变更统一计算，防止 DB 未持久化时归零 */
  const taskChangesCount = useMemo(() => {
    return resolveTaskFileChanges(currentTask?.fileChanges, artifacts, currentTask?.messages).length;
  }, [currentTask?.fileChanges, artifacts, currentTask?.messages]);
  const isBot = useAppStore((s) => s.tasks.find(t => t.id === taskId)?.welcomeMode === "bot");
  const regenerateMessage = useAppStore((s) => s.regenerateMessage);
  const continueExternalAgent = useAppStore((s) => s.continueExternalAgent);
  const deleteUserMessage = useAppStore((s) => s.deleteUserMessage);
  const createBranchFromMessage = useAppStore((s) => s.createBranchFromMessage);
  const conversationBranchEnabled = useAppStore((s) => s.conversationBranchEnabled);
  const branchCreating = useAppStore(
    (s) => s.branchCreatingTaskId !== null && s.branchCreatingTaskId === s.activeTaskId,
  );
  /** 对话分支来源 chip：源自本任务（用于「查看分支」入口的 disable 判断；未用于本文件展示） */
  const canBranch = Boolean(
    !isBot && conversationBranchEnabled && !btw && !message.streaming && message.createdAt > 0,
  );
  const onBranchFromMessage = (): void => {
    if (!canBranch || branchCreating) return;
    void createBranchFromMessage(message.id, {
      role: message.role,
      entryId: message.entryId,
    });
  };
  /** 本条助手消息是否正作为「重新生成」的源（两阶段提交 pending 中）。 */
  const regenerating = useAppStore((s) =>
    Object.values(s.pendingRegenerations).some(
      (p) => p.taskId === s.activeTaskId && p.sourceAssistantMessageId === message.id,
    ),
  );
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** 任务执行中（流式/挂起交互/状态 in_progress）→ 删除与分支都会先停止当前运行 */
  const taskExecuting = useAppStore((s) => {
    const active = s.tasks.find((item) => item.id === s.activeTaskId) ?? null;
    return taskHasActiveExecution(active);
  });
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const copyFinalText = useCallback(async (): Promise<void> => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    const text = assistantCopyText(message);
    if (!text) {
      setCopyState("empty");
      copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch (err) {
      console.warn("[MessageItem] 复制失败", err);
      setCopyState("failed");
    }
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
  }, [message]);

  if (message.role === "user") {
    const rawText = message.blocks
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();
    const text = userDisplayText(rawText);
    const attachments = message.attachments ?? [];
    const taskReferences = message.taskReferences ?? [];
    // 当前会话发送时已写入；历史恢复则从 prompt 块解析
    const terminalContext =
      message.terminalContext ?? parseTerminalContextFromPrompt(rawText);
    const selectionLabels = (
      message.selectionLabels?.length
        ? message.selectionLabels
        : message.selectionLabel
          ? [message.selectionLabel]
          : selectionLabelsFromPrompt(rawText)
    )
      .map((label) => label.trim())
      .filter(Boolean);
    const parsedMeta = parseAttachedMetaFromPrompt(rawText);
    const skillCommands =
      message.skillCommands?.length ? message.skillCommands : parsedMeta.skillCommands;
    const mcpNames = message.mcpNames?.length ? message.mcpNames : parsedMeta.mcpNames;
    const connectorNames =
      message.connectorNames?.length ? message.connectorNames : parsedMeta.connectorNames;
    const expert = message.expert?.name?.trim()
      ? message.expert
      : undefined;
    const hasMetaChips =
      attachments.length > 0 ||
      Boolean(terminalContext) ||
      selectionLabels.length > 0 ||
      Boolean(expert) ||
      skillCommands.length > 0 ||
      mcpNames.length > 0 ||
      connectorNames.length > 0;
    // 仅技能/MCP、无说明文字时仍渲染芯片气泡（不再整行空白）
    if (!text && taskReferences.length === 0 && !hasMetaChips) {
      return <div className="msg-row user" />;
    }
    return (
      <div className="msg-row user">
        <div className="user-bubble">
          {taskReferences.length > 0 && <TaskReferenceNotice references={taskReferences} />}
          {hasMetaChips && (
            <div className="user-bubble-meta">
              {expert && (
                <span
                  key={`expert-${expert.id}`}
                  className="user-attachment user-expert-ref"
                  title={`专家：${expert.name}`}
                >
                  <span className="user-expert-emoji" aria-hidden>
                    {expert.emoji?.trim() || "🧙"}
                  </span>
                  <span className="user-attachment-name">{expert.name}</span>
                </span>
              )}
              {skillCommands.map((cmd) => (
                <span
                  key={`skill-${cmd}`}
                  className="user-attachment user-skill-ref"
                  title={`技能 /${cmd}`}
                >
                  <IconSparkles size={13} />
                  <span className="user-attachment-name">/{cmd}</span>
                </span>
              ))}
              {mcpNames.map((name) => (
                <span
                  key={`mcp-${name}`}
                  className="user-attachment user-mcp-ref"
                  title={`MCP ${name}`}
                >
                  <IconBlocks size={13} />
                  <span className="user-attachment-name">{name}</span>
                </span>
              ))}
              {connectorNames.map((name) => (
                <span
                  key={`conn-${name}`}
                  className="user-attachment user-connector-ref"
                  title={`连接器 ${name}`}
                >
                  <IconLink size={13} />
                  <span className="user-attachment-name">{name}</span>
                </span>
              ))}
              {selectionLabels.map((selectionLabel, index) => (
                <span
                  key={`selection-${index}-${selectionLabel}`}
                  className="user-attachment user-selection-ref"
                  title={`抓取元素：${selectionLabel}`}
                >
                  <IconTarget size={14} />
                  <span className="user-attachment-name">{selectionLabel}</span>
                </span>
              ))}
              {terminalContext && (
                <span
                  className="user-attachment user-terminal-ref"
                  title={
                    terminalContext.preview
                      ? `终端上下文（${terminalContext.source === "selection" ? "选中文本" : "最近输出"}）\n${terminalContext.preview}${terminalContext.charCount > 240 ? "…" : ""}`
                      : `终端上下文（${terminalContext.source === "selection" ? "选中文本" : "最近输出"}）· ${terminalContext.charCount} 字符`
                  }
                >
                  <IconCode size={14} />
                  <span className="user-attachment-name">
                    终端 · {terminalContext.charCount} 字符
                  </span>
                </span>
              )}
              {attachments.map((att) => {
                const label = attachmentLabel(att);
                return (
                  <button
                    type="button"
                    key={att.path ?? att.name}
                    className="user-attachment user-attachment-file"
                    title={att.path ?? att.name}
                    disabled={!att.path?.trim() || btw}
                    onClick={() => {
                      const path = att.path?.trim();
                      if (!path || btw) return;
                      if (/^(?:[a-zA-Z]:[\\/]|[/\\]|file:)/.test(path)) void openLocalAbsoluteFile(path);
                      else void openWorkspaceFile(path, label);
                    }}
                  >
                    <FileBadge name={label} size={16} />
                    <span className="user-attachment-name">{label}</span>
                  </button>
                );
              })}
            </div>
          )}
          {text ? (
            <CollapsibleBody textLength={text.length}>
              <div className="user-bubble-text">{text}</div>
            </CollapsibleBody>
          ) : null}
        </div>
        {/* 用户每条消息外侧右下角：复制 / 导入 / 更多（助手消息不显示） */}
        <MessageActionBar
          copyText={text}
          importable={!btw}
          moreItems={
            btw
              ? []
              : [
                  ...(canBranch
                    ? [
                        {
                          label: branchCreating ? "正在创建分支…" : "从这里创建分支",
                          onClick: onBranchFromMessage,
                        },
                      ]
                    : []),
                  {
                    label: "复制全文",
                    onClick: () => {
                      if (!text) return;
                      void navigator.clipboard.writeText(text).catch(() => undefined);
                    },
                  },
                  ...(!isBot ? [{
                    label: "删除此消息",
                    danger: true,
                    onClick: () => setDeleteConfirmOpen(true),
                  }] : []),
                ]
          }
        />
        <ConfirmDialog
          open={deleteConfirmOpen}
          title="删除这条消息？"
          body={
            <>
              <div>这条消息以及它之后的对话将从当前会话分支中移除。</div>
              <div style={{ marginTop: 6 }}>后续模型上下文不会再包含这些内容。此操作不可撤销。</div>
              {taskExecuting && (
                <div style={{ marginTop: 6 }}>该任务正在执行，删除会先停止当前运行。</div>
              )}
            </>
          }
          confirmLabel={taskExecuting ? "停止并删除" : "删除消息"}
          danger
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={() => {
            setDeleteConfirmOpen(false);
            void deleteUserMessage(message.id).catch((cause) => {
              setDeleteError(cause instanceof Error ? cause.message : String(cause));
            });
          }}
        />
        <ConfirmDialog
          open={Boolean(deleteError)}
          title="无法删除消息"
          body={deleteError}
          confirmLabel="知道了"
          onCancel={() => setDeleteError(null)}
          onConfirm={() => setDeleteError(null)}
        />
      </div>
    );
  }

  const chipSource = visibleArtifacts ?? artifacts;
  const chipIds = (message.artifactIds ?? []).filter((id) =>
    chipSource.some((artifact) => artifact.id === id),
  );
  const artifactCount = chipIds.length;

  return (
    <div className={`msg-row${message.presentationKey && message.streaming ? " bot-message-enter" : ""}`}>
      <ChatImageScope taskId={taskId ?? null}><div className="msg-body">
        <div className="assistant-avatar-row">
          <div
            className={`assistant-avatar${message.externalAgent ? " external-agent-avatar" : ""}`}
            title={message.externalAgent ? `${message.externalAgent.name} · ACP` : "MyBuddy (Pi Agent)"}
          >
            {message.externalAgent ? <IconBlocks size={13} /> : <IconPiLogo size={13} />}
          </div>
          <span className="assistant-name">
            {message.externalAgent ? (
              <>
                <span>{message.externalAgent.name}</span>
                <span className="assistant-source-badge">
                  ACP{message.externalAgent.continuationMode === "resume" || message.externalAgent.continuationMode === "load" ? " · 续聊" : message.externalAgent.continuationMode === "fallback_new" ? " · 新会话" : ""}
                </span>
                {message.externalAgent.recoveryState === "resume-available" && <span className="assistant-source-badge">可恢复</span>}
                {message.externalAgent.recoveryState === "new-run-required" && <span className="assistant-source-badge">需新执行</span>}
                {message.externalAgent.verificationStatus === "workspace_observed" && <span className="assistant-source-badge" title="仅表示 MyBuddy 已观察工作目录并登记产物，不表示业务结果正确">工作目录已观察</span>}
              </>
            ) : (
              <span className="brand-mybuddy"><span className="brand-my">My</span><span className="brand-buddy">Buddy</span></span>
            )}
          </span>
        </div>

        <ExecutionTimeline message={message} />

        {(message.interactions ?? []).map((interaction) => (
          <ConversationInteractionCard key={interaction.id} interaction={interaction} />
        ))}

        <div className="assistant-card">
          {/* 助手回复不折叠，完整展示；仅用户消息长文折叠。
              正文区 = finalBlocks 的 prose 段（tool_start 冻结段，空段渲染过滤）。 */}
          {nonEmptyFinalTextBlocks(message.finalBlocks).map((block, i) => {
            const canHideRecoveredDirective = Boolean(message.streaming) || (message.interactions?.length ?? 0) > 0;
            const visibleBlock = block.type === "text" && canHideRecoveredDirective
              ? { ...block, text: requestUserInputDisplayText(block.text, Boolean(message.streaming)) }
              : block;
            if (visibleBlock.type === "text" && !visibleBlock.text.trim()) return null;
            return (
              <MessageBlockView
                key={i}
                block={visibleBlock}
                index={i}
                messageId={message.id}
                streaming={message.streaming}
              />
            );
          })}

          {!btw && <MessageImages message={message} />}
          {artifactCount > 0 && (
            <ArtifactChipRow ids={chipIds} allArtifacts={chipSource} />
          )}

          {/* 任务级产物/变更入口：每条助手消息都继承显示（不依赖本条是否新产出）
              产物芯片与计数跟随面板过滤（visibleArtifacts）；变更计数仍用全量 */}
          {!btw && (Boolean(message.externalAgent?.runId && message.externalAgent.resumeSupported === true) || chipSource.length > 0 || taskChangesCount > 0) && (
            <div className="msg-links">
              {message.externalAgent?.runId && message.externalAgent.resumeSupported === true && !message.streaming && (
                <button
                  type="button"
                  className="msg-link"
                  onClick={() => continueExternalAgent({
                    runId: message.externalAgent!.runId!,
                    agentId: message.externalAgent!.id as import("@shared/external-agent").ExternalAgentId,
                    agentName: message.externalAgent!.name,
                  })}
                >
                  继续 {message.externalAgent.name}
                </button>
              )}
              {chipSource.length > 0 && (
                <button type="button" className="msg-link" onClick={showAllArtifacts}>
                  查看所有产物 ({chipSource.length})
                </button>
              )}
              {taskChangesCount > 0 && (
                <button type="button" className="msg-link" onClick={showAllChanges}>
                  查看所有变更 ({taskChangesCount})
                </button>
              )}
            </div>
          )}

          {/* footer 始终渲染占位（streaming 时 is-streaming 隐藏），避免 assistant_end 高度突变 */}
          <div className={`msg-footer${message.streaming ? " is-streaming" : ""}`}>
            <button
              type="button"
              className={`icon-btn ${copyState === "copied" ? "copied" : ""}`}
              title={
                copyState === "copied"
                  ? "已复制到剪贴板"
                  : copyState === "failed"
                    ? "复制失败"
                    : copyState === "empty"
                      ? "没有可复制的内容"
                      : "复制"
              }
              onClick={() => void copyFinalText()}
            >
              {copyState === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </button>
            {btw ? null : (
              <>
                <button className="icon-btn" title="赞">
                  <IconThumbsUp size={14} />
                </button>
                <button className="icon-btn" title="踩">
                  <IconThumbsDown size={14} />
                </button>
                {!isBot && !message.externalAgent && (
                  <button
                    type="button"
                    className="icon-btn"
                    title={regenerating ? "正在重新生成…" : "重新生成"}
                    disabled={regenerating}
                    onClick={() => regenerateMessage(message.id)}
                  >
                    <IconRefresh size={14} />
                  </button>
                )}
                {canBranch && (                  <button
                    type="button"
                    className="icon-btn"
                    title={branchCreating ? "正在创建分支…" : "从这里创建分支"}
                    disabled={branchCreating}
                    onClick={onBranchFromMessage}
                  >
                    <IconGitBranch size={14} />
                  </button>
                )}
              </>
            )}
            {message.generateError && (
              <span className="msg-generate-error" title={message.generateError}>
                重新生成失败，原回复已保留
              </span>
            )}
            {regenerating && <span className="msg-regenerating">正在重新生成…</span>}
            {message.modelName && (
              <span className="msg-model-badge">
                <IconZap size={12} /> {message.modelName}
              </span>
            )}
            <span className="msg-time">{clockTime(message.createdAt)}</span>
          </div>
        </div>
      </div></ChatImageScope>
    </div>
  );
}

export default memo(MessageItem);
