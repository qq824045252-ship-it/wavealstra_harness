import { useBotWorkDetail } from "@/hooks/useBotWorkDetail";
import ScopedMemoryPanel from "../settings/ScopedMemoryPanel";
import { BotExecutionDiagnosticsButton } from "./BotExecutionDiagnostics";
import { BotReplyMetrics } from "./BotReplyMetrics";
import { BotCallThread } from "./BotCallThread";
import { useBotThreadScroll } from "@/hooks/useBotThreadScroll";
import { BotComposerCapabilities } from "./BotComposerCapabilities";
import { BotWorkConversationDetail } from "./BotWorkConversationDetail";
import { HistoricalTeamWorkDetail } from "./HistoricalTeamWorkDetail";
import { BotMessageActions } from "./BotMessageActions";
import { BotRename } from "./BotRename";
import { BotTeamManagement } from "./BotTeamManagement";
import { BotTeamSettings } from "./BotTeamSettings";
import { botConversationScope } from "@/store/app/slices/botConversation";
import { BotWorkNavigation } from "./BotWorkNavigation";
import { ComposerAttachmentChips } from "@/components/chat/ComposerAttachmentChips";
import { composerFiles, mergeComposerAttachments, pastedComposerFiles, pickComposerAttachment } from "@/components/chat/composerAttachments";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { BotDto, WorkProjectionDto } from "@shared/bot-work";
import { botExternalAgentTaskId, botMessageDisplayText, type BotMessageDto } from "@shared/bot-conversation";
import type { BotWorkHostStatusDto } from "@shared/bot-work-ipc";
import { useAppStore } from "@/store/appStore";
import { rewriteMarkdownImageSources } from "@shared/markdown-images";
import { artifactImageUrl } from "@shared/artifact-ipc";
import { ChatImageScope } from "@/components/chat/ChatImage";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatMarkdown from "@/components/chat/ChatMarkdown";
import { IconPlus, IconArchive, IconChevronDown, IconArrowUp, IconBot, IconChevronRight, IconListTodo, IconPanel, IconSettings, IconX } from "@/components/common/icons";
import { activeBotReply, personalBotWork, linkedConversationWork, botMessageStatus, botMessageWorkLinks, botWorkTimeline, shouldSendBotComposer, type BotWorkspaceView } from "@/lib/botWorkspacePresentation";
import { BotWorkBrowser } from "./BotWorkBrowser";
import { BotResultReport } from "./BotWorkResult";
import { BotActivityMonitor } from "./BotActivityMonitor";
import { BotDeletion } from "./BotDeletion";
import { BotExecutionSettings } from "./BotExecutionSettings";
import { BotExpertReview } from "./BotExpertReview";
import "./BotWorkspacePage.css";

function presenceLabel(bot: BotDto, host: BotWorkHostStatusDto | null): string {
  if (bot.status === "disabled") return "已停用";
  if (bot.status === "paused") return "已暂停";
  if (!host) return "状态待核实";
  return host.online ? "在线" : "离线";
}

const examples = [
  { title: "梳理今天的重点", text: "帮我梳理今天最重要的三件事。先问我必要的背景。" },
  { title: "持续跟进一件事", text: "我想让你持续跟进一件事，先帮我明确目标、检查频率和需要我确认的边界。" },
  { title: "一起推进一个目标", text: "我想把一个目标拆成可执行的步骤，先和我确认目标与验收条件。" },
];

export default function BotWorkspacePage(props: { onToggleNavigation?: () => void; navigationVisible?: boolean; onCreateBot?: () => void } = {}): React.JSX.Element {
  const attachmentDrafts = useAppStore(s => s.botAttachmentDrafts);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const botDraft = useAppStore(s => s.botDraft);
  const setBotDraft = useAppStore(s => s.setBotDraft);
  const submitBotDraft = useAppStore(s => s.submitBotDraft);
  const notice = useAppStore(s => s.botSubmissionNotice);
  const histories = useAppStore(s => s.botHistories);
  const historyPages = useAppStore(s => s.botHistoryPages);
  const sendErrors = useAppStore(s => s.botConversationErrors);
  const pendingSends = useAppStore(s => s.botPendingSends);
  const identities = useAppStore(s => s.botIdentities);
  const works = useAppStore(s => s.botWorks);
  const activeBotId = useAppStore(s => s.activeBotId);
  const activeTeam = useAppStore(s => s.activeTeam);
  const teamId = activeTeam?.templateId;
  const scopeKey = activeBotId ? botConversationScope(activeBotId, teamId) : "";
  const selectedWorkId = useAppStore(s => s.selectedWorkId);
  const historicalTeamWork = useAppStore(s => s.historicalTeamWork);
  const setSelectedWorkId = useAppStore(s => s.setSelectedWorkId);
  const hostStatus = useAppStore(s => s.botHostStatus);
  const workError = useAppStore(s => s.botWorkError);
  const allWorksLoaded = useAppStore(s => s.botWorkCursor?.scope === "all");
  const [includeClosed, setIncludeClosed] = useState(allWorksLoaded);
  const [view, setView] = useState<BotWorkspaceView>("conversation");
  const suppressAutoInline = useRef(false);
  const [inlineWorkId, setInlineWorkId] = useState<string | null>(null);
  const returnTarget = useRef<{ scope: string; conversationId?: string; view: BotWorkspaceView; scrollTop: number; follow: boolean; trigger: HTMLElement | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const requestedWork = useRef<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const browserRef = useRef<HTMLElement>(null);
  const sourceViewRef = useRef<HTMLElement>(null);
  const historicalReturn = useRef<{ scope: string; conversationId?: string; source: HTMLElement | null; scrollTop: number; follow: boolean; trigger: HTMLElement | null } | null>(null);
  const settingsRef = useRef<HTMLDialogElement>(null);
  const settingsEpoch = useRef(0);
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const renderedSettingsEpoch = settingsEpoch.current;
  const closeSettings = () => { settingsEpoch.current++; setSettingsOpen(false); };
  const newConversationRef = useRef<HTMLDialogElement>(null);
  const lastBot = useRef(scopeKey);
  const scopeChanged = lastBot.current !== scopeKey;
  const previousSelection = useRef(selectedWorkId);
  const selectionChanged = previousSelection.current !== selectedWorkId;
  previousSelection.current = selectedWorkId;
  const activeBot = identities.find(bot => bot.botId === activeBotId) ?? null;
  const botWorks = useMemo(() => works.filter(work => !work.team?.removedAt && (teamId ? work.team?.teamId === teamId : personalBotWork(work, activeBotId))), [works, activeBotId, teamId]);
  const displayName = activeTeam?.name ?? activeBot?.displayName ?? "Bot";
  const messages = activeBotId ? histories[scopeKey]?.messages ?? [] : [];
  // Lists/counts retain team ownership. A trusted result link in the source
  // conversation can still open its team's details without moving the Work.
  const detailWorkCandidates = useMemo(() => {
    const owned = new Set(botWorks.map(work => work.workId));
    return works.filter(work => owned.has(work.workId) || linkedConversationWork(work, messages, activeBotId, teamId, histories[scopeKey]?.conversationId));
  }, [works, botWorks, messages, activeBotId, teamId, histories[scopeKey]?.conversationId]);
  // Stream frames retain unchanged Work objects. Keep the list identity too
  // when membership/order are unchanged, so unrelated messages can skip rendering.
  const stabilizeDetailWorks = useShallow((value: WorkProjectionDto[]) => value);
  const detailWorks = stabilizeDetailWorks(detailWorkCandidates);
  const detail = useBotWorkDetail(scopeChanged ? null : inlineWorkId, `${scopeKey}:${histories[scopeKey]?.conversationId ?? ""}`);
  const loadedWork = detail.work;
  const inlineWork = loadedWork && !loadedWork.team?.removedAt && (teamId ? loadedWork.team?.teamId === teamId : personalBotWork(loadedWork, activeBotId)
    || linkedConversationWork(loadedWork, messages, activeBotId, teamId, histories[scopeKey]?.conversationId)) ? loadedWork : null;
  const selected = (view === "conversation" ? detailWorks : botWorks).find(work => work.workId === selectedWorkId) ?? null;
  const questionsByRequest = useMemo(() => new Map(messages.filter(item => item.role === "user").map(item => [item.requestId, item])), [messages]);
  const activeReply = activeBotReply(messages);
  const { followLatest, awayFromBottom, pauseFollowing, restoreScroll, followBottom, preserveHistoryPosition } = useBotThreadScroll(
    threadRef, `${scopeKey}:${histories[scopeKey]?.conversationId ?? ""}`,
    view === "conversation" && !inlineWorkId && !historicalTeamWork, messages,
  );
  const pending = Object.values(pendingSends).filter(item => item.request.botId === activeBotId && item.request.teamId === teamId);
  const runningReplies = messages.filter(item => item.role === "assistant" && item.status === "running");
  const queuedReplies = messages.filter(item => item.role === "assistant" && item.status === "queued");
  const [replyReference, setReplyReference] = useState<BotMessageDto | null>(null);
  const reference = replyReference?.conversationId === histories[scopeKey]?.conversationId ? replyReference : null;
  const attachments = activeBotId ? attachmentDrafts[scopeKey] ?? [] : [];
  const composerSelection = useAppStore(state => state.botComposerDrafts[scopeKey]);
  const canSend = Boolean(activeBotId && (botDraft.trim() || attachments.length || composerSelection?.refTasks?.length || composerSelection?.refFiles?.length) && !attachmentBusy);
  const addAttachments = async (source: File[] | "pick") => {
    const botId = activeBotId;
    if (!botId) return;
    setAttachmentBusy(true); setAttachmentError("");
    try {
      const selected = source === "pick" ? await pickComposerAttachment() : undefined;
      const incoming = source === "pick" ? (selected ? [selected] : []) : await composerFiles(source);
      const state = useAppStore.getState();
      state.setBotAttachments(scopeKey, mergeComposerAttachments(state.botAttachmentDrafts[scopeKey] ?? [], incoming));
    } catch (error) { if (useAppStore.getState().activeBotId === botId) setAttachmentError(error instanceof Error ? error.message : String(error)); }
    finally { setAttachmentBusy(false); }
  };

  useEffect(() => () => { requestedWork.current = null; }, []);
  // Record the mounted source before React hides it and focuses the history
  // viewer. History is a read-only route, not a writable team/composer selection.
  useEffect(() => useAppStore.subscribe((state, previous) => {
    if (!state.historicalTeamWork || previous.historicalTeamWork) return;
    requestedWork.current = null;
    setNavigationNotice("");
    const source = sourceViewRef.current?.querySelector<HTMLElement>(".bot-work-conversation-body, .bot-work-browser, .bot-thread") ?? null;
    historicalReturn.current = { scope: currentScope.current,
      conversationId: state.botHistories[currentScope.current]?.conversationId,
      source, scrollTop: source?.scrollTop ?? 0, follow: followLatest.current,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    pauseFollowing();
  }), [pauseFollowing]);
  useEffect(() => { if (historicalTeamWork) setIncludeClosed(true); }, [historicalTeamWork?.workId]);
  useEffect(() => { void useAppStore.getState().refreshBotWork(includeClosed); }, [includeClosed]);
  useEffect(() => {
    if (!activeBotId) return;
    const refresh = () => { void useAppStore.getState().refreshBotHistory(activeBotId, teamId); void useAppStore.getState().refreshBotWork(includeClosed); };
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [activeBotId, teamId, includeClosed]);
  useEffect(() => {
    if (lastBot.current === scopeKey) return;
    lastBot.current = scopeKey; setReplyReference(null); setAttachmentError("");
    requestedWork.current = null; setNavigationNotice(""); setInlineWorkId(null); returnTarget.current = null; historicalReturn.current = null;
    setView("conversation"); closeSettings(); setArchiveConfirm(false); setNewConversationOpen(false);
  }, [scopeKey]);
  useEffect(() => {
    if (historicalTeamWork) return;
    if (suppressAutoInline.current) { suppressAutoInline.current = false; return; }
    if (scopeChanged && !selectionChanged && !selected) return;
    if (!selectedWorkId || (!scopeChanged && inlineWorkId === selectedWorkId)) return;
    // Menu and cross-Bot/team navigation set selection in the store. Consume it
    // only after this render has resolved the target scope, not in a stale callback.
    returnTarget.current = { scope: scopeKey, conversationId: histories[scopeKey]?.conversationId,
      view: scopeChanged ? "conversation" : view,
      scrollTop: scopeChanged ? 0 : (view === "conversation" ? threadRef.current : browserRef.current)?.scrollTop ?? 0, follow: followLatest.current,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    setNavigationNotice("");
    pauseFollowing(); setIncludeClosed(true);
    setInlineWorkId(selectedWorkId);
  }, [selectedWorkId, scopeKey, view]);
  useEffect(() => {
    const dialog = settingsRef.current;
    if (settingsOpen) dialog?.showModal(); else if (dialog?.open) dialog.close();
  }, [settingsOpen]);
  useEffect(() => {
    const dialog = newConversationRef.current;
    if (newConversationOpen) dialog?.showModal(); else if (dialog?.open) dialog.close();
  }, [newConversationOpen]);
  const returnFromWork = () => {
    const target = returnTarget.current;
    requestedWork.current = null;
    setInlineWorkId(null); setSelectedWorkId(null);
    setNavigationNotice("");
    returnTarget.current = null;
    if (target?.scope === currentScope.current) setView(target.view);
    requestAnimationFrame(() => {
      if (target?.scope !== currentScope.current) return;
      const source = target.view === "conversation" ? threadRef.current : browserRef.current;
      // A changed conversation has no matching scroll position. Lists are scoped
      // to the Bot/team and remain the same source even after a new conversation.
      if (target.view === "conversation" && target.conversationId !== useAppStore.getState().botHistories[target.scope]?.conversationId) {
        source?.focus({ preventScroll: true }); return;
      }
      if (target.view === "conversation") restoreScroll(target.scrollTop, target.follow);
      else if (source) source.scrollTop = target.scrollTop;
      // Archive/delete/status updates can legitimately remove the original card.
      (target.trigger?.isConnected ? target.trigger : source)?.focus({ preventScroll: true });
    });
  };
  const returnFromHistory = () => {
    const target = historicalReturn.current;
    historicalReturn.current = null;
    useAppStore.getState().setHistoricalTeamWork(null);
    requestAnimationFrame(() => {
      if (target && target.scope !== currentScope.current) return;
      const source = target?.source?.isConnected ? target.source
        : sourceViewRef.current?.querySelector<HTMLElement>(".bot-work-conversation-body, .bot-work-browser, .bot-thread");
      if (source && target) {
        if (!source.classList.contains("bot-thread")) source.scrollTop = target.scrollTop;
        else if (target.conversationId === useAppStore.getState().botHistories[target.scope]?.conversationId) restoreScroll(target.scrollTop, target.follow);
      }
      const trigger = target?.trigger;
      (trigger?.isConnected && trigger.getClientRects().length ? trigger : source)?.focus({ preventScroll: true });
    });
  };
  const conversationId = histories[scopeKey]?.conversationId;
  const openWork = useCallback((workId: string) => {
    suppressAutoInline.current = false;
    const sourceScope = scopeKey;
    const sourceConversation = conversationId;
    const target = { scope: sourceScope, conversationId: sourceConversation, view,
      scrollTop: (view === "conversation" ? threadRef.current : browserRef.current)?.scrollTop ?? 0, follow: followLatest.current,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    const show = () => {
      setSelectedWorkId(workId);
      setIncludeClosed(true); // Keep a selected Work visible when it finishes during reading.
      returnTarget.current = target; pauseFollowing();
      setInlineWorkId(workId);
      setNavigationNotice("");
    };
    requestedWork.current = workId;
    show();
  }, [scopeKey, conversationId, view, setSelectedWorkId, pauseFollowing, followLatest]);
  const changeView = (next: BotWorkspaceView) => {
    requestedWork.current = null; setNavigationNotice("");
    returnTarget.current = null; setSelectedWorkId(null); setInlineWorkId(null);
    setView(next);
    if (next === "closed" || next === "completed") setIncludeClosed(true);
  };
  const send = () => {
    if (!canSend) return;
    followBottom(); setView("conversation"); void submitBotDraft({ referenceMessageId: reference?.messageId }); setReplyReference(null);
  };
  const draftExample = (text: string) => { setBotDraft(text); setView("conversation"); composerRef.current?.focus(); };
  const replyToBlocker = (work: WorkProjectionDto, blocker: WorkProjectionDto["blockers"][number]) => {
    const state = useAppStore.getState();
    const owner = state.botIdentities.find(bot => bot.botId === work.ownerBotId && bot.status === "active");
    if (!owner) { setNavigationNotice("负责人暂不可用，请先核对 Bot 状态；问题和已有草稿均已保留。"); return; }
    const marker = `问题引用：${work.workId} / ${blocker.blockerId}`;
    const existing = state.activeBotId === owner.botId ? state.botDraft : state.botDrafts[owner.botId] ?? "";
    const quote = `${marker}\n事项：${work.title}\n查看版本：要求 r${work.intentRevision}，负责人代次 ${work.ownerEpoch}，状态 v${work.stateVersion}\n原问题：${blocker.reason}\n我的回复：\n\n请先核对当前状态和这条回复；保留已完成步骤，只处理本次补充。`;
    const draft = existing.includes(marker) ? existing : [existing, quote].filter(Boolean).join("\n\n");
    if (draft.length > 32000) { setNavigationNotice("现有草稿较长，请先整理后再引用问题。没有覆盖或发送任何内容。"); return; }
    // setActiveBotId retains the previous Bot's draft and restores the owner's.
    if (state.activeBotId !== owner.botId) state.setActiveBotId(owner.botId);
    suppressAutoInline.current = true;
    state.setSelectedWorkId(work.workId); state.setBotDraft(draft);
    setView("conversation");
    requestAnimationFrame(() => { composerRef.current?.focus(); });
  };

  const replyToMessage = useCallback((message: BotMessageDto) => {
    setReplyReference(message); composerRef.current?.focus();
  }, []);
  const cancelMessage = useCallback((message: BotMessageDto) => {
    if (activeBotId) void useAppStore.getState().cancelBotSend(message.botId, message.requestId);
  }, [activeBotId]);

  // Draft edits and composer controls do not change the transcript. Keep its
  // elements stable; message/store/context updates still render their own content.
  const messageTimeline = useMemo(() => view === "conversation" && messages.length > 0 ? (<div className="bot-message-list">{botWorkTimeline(messages).map(row => row.kind === "message"
            ? <TimelineMessage key={row.key} message={row.message} botName={displayName} works={detailWorks} onOpenWork={openWork} sourceQuestion={questionsByRequest.get(row.message.requestId)} onReply={replyToMessage} onCancel={cancelMessage} />
            : <details key={row.key} className="bot-work-progress" aria-label="事项进展记录">
              <summary>{row.workIds.length > 1 ? `${row.workIds.length} 个事项` : detailWorks.find(work => work.workId === row.workId)?.title ?? "事项"} · {row.messages.length} 条执行记录（展开查看）</summary>
              {row.messages.map(message => <TimelineMessage key={message.messageId} message={message} botName={displayName} works={detailWorks} onOpenWork={openWork} onCancel={ignoreMessageCancel} />)}
            </details>)}</div>) : null, [view, messages, displayName, detailWorks, openWork, questionsByRequest, replyToMessage, cancelMessage]);

  return <div className="bot-workspace" onKeyDownCapture={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { closeSettings(); } }}>
    {historicalTeamWork && <section className="bot-conversation" aria-label="历史团队事项">
      <HistoricalTeamWorkDetail snapshot={historicalTeamWork} onBack={returnFromHistory} />
    </section>}
    <section ref={sourceViewRef} hidden={Boolean(historicalTeamWork)} className="bot-conversation" aria-label="Bot 对话">
      <header className="bot-workspace-header" hidden={Boolean(inlineWorkId)}>
        {props.onToggleNavigation && <button type="button" className="bot-icon-button" aria-label={props.navigationVisible ? "收起导航" : "展开导航"} aria-expanded={props.navigationVisible} onClick={props.onToggleNavigation}><IconPanel size={18} /></button>}
        <span className="bot-avatar bot-header-avatar" aria-hidden="true"><IconBot size={21} /></span>
        <div className="bot-heading"><h1>{activeTeam?.name ?? activeBot?.displayName ?? "Bot 模式"}</h1><p><span className={`bot-presence ${hostStatus?.online && activeBot?.status === "active" ? "is-online" : ""}`} />{activeBot ? presenceLabel(activeBot, hostStatus) : "你的长期个人助理"}<span className="bot-heading-description"> · {activeTeam ? `团队工作台 · ${activeTeam.members.length + 1} 位成员` : "对话有延续，事项有着落"}</span></p></div>
        <div className="bot-workspace-actions">
          {activeBotId && <BotExecutionDiagnosticsButton request={{kind:"foreground",botId:activeBotId,teamId,conversationId:histories[scopeKey]?.conversationId}} />}
          <button type="button" className="bot-quiet-button bot-new-conversation" disabled={!activeBot} onClick={() => {
            setArchiveError("");
            if (messages.length === 0) {
              setView("conversation"); setSelectedWorkId(null);
              requestAnimationFrame(() => composerRef.current?.focus());
              return;
            }
            setNewConversationOpen(true);
          }}>新对话</button>
          <BotActivityMonitor onOpenWork={() => { suppressAutoInline.current = false; setIncludeClosed(true); }} onOpenBotMessage={messageId => {
            pauseFollowing();
            setView("conversation");
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const node = Array.from(threadRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []).find(item => item.dataset.messageId === messageId);
              node?.scrollIntoView({ block: "center" });
            }));
          }} />
          <button type="button" className="bot-icon-button" aria-label={activeTeam ? "团队设置与管理" : "Bot 设置与对话管理"} onClick={() => { settingsEpoch.current++; setSettingsOpen(true); }}><IconSettings size={18} /></button>
        </div>
      </header>
      {!inlineWorkId && <BotWorkNavigation view={view} onChange={changeView} />}
      {workError && <p className="bot-alert" role="alert">{workError}</p>}
      {navigationNotice && <p className="bot-navigation-notice" role="status">{navigationNotice}</p>}
      {inlineWorkId && <BotWorkConversationDetail work={inlineWork} workId={inlineWorkId} loading={detail.loading} error={detail.error} conversationName={displayName}
        ownerName={inlineWork?.team?.teamName ?? identities.find(bot => bot.botId === inlineWork?.ownerBotId)?.displayName ?? displayName}
        includeClosed={includeClosed} returnLabel={view === "active" ? "进行中" : view === "completed" ? "已完成" : view === "closed" ? "归档" : "对话"} onBack={returnFromWork}
        onReplyToBlocker={blocker => { if (inlineWork) { returnFromWork(); replyToBlocker(inlineWork, blocker); } }} />}
      {view === "conversation" ? <>
        <div className="bot-thread" hidden={Boolean(inlineWorkId)} ref={threadRef} role="log" aria-label="对话记录" aria-live="off" tabIndex={0}>
          {messages.length > 0 && <div className="bot-history-controls">
            <button type="button" className="bot-quiet-button" aria-disabled={historyPages[scopeKey]?.loading || histories[scopeKey]?.before === undefined}
              onClick={() => {
                if (!activeBotId || historyPages[scopeKey]?.loading || histories[scopeKey]?.before === undefined) return;
                preserveHistoryPosition();
                void useAppStore.getState().loadOlderBotHistory(activeBotId, teamId);
              }}>{historyPages[scopeKey]?.loading ? "正在加载更早消息…" : histories[scopeKey]?.before !== undefined ? "加载更早消息" : "已到最早消息"}</button>
            {historyPages[scopeKey]?.error && <p role="alert">{historyPages[scopeKey].error}</p>}
          </div>}
          {messages.length === 0 ? <div className="bot-conversation-empty">
            <span className="bot-welcome-icon" aria-hidden="true"><IconBot size={30} /></span>
            <span className="bot-eyebrow">从一句话开始</span>
            <h2>{activeBot ? "有什么想一起推进的？" : "还没有 Bot"}</h2>
            <p>{activeBot ? "聊想法、交代事项，或继续上次的进展。普通聊天不会自动创建事项。" : "创建一个 Bot，给它名称和职责，就能开始独立的对话。"}</p>
            {!activeBot && props.onCreateBot && <button type="button" className="bot-empty-create" onClick={props.onCreateBot}>创建第一个 Bot</button>}
            {activeBot && <div className="bot-example-grid">{examples.map(example => <button type="button" key={example.title} onClick={() => draftExample(example.text)}><span>{example.title}</span><IconArrowUp size={16} /></button>)}</div>}
          </div> : messageTimeline}
        </div>
      </> : <BotWorkBrowser key={`${scopeKey}-${view}`} hidden={Boolean(inlineWorkId)} scrollRef={browserRef} view={view} selectedWorkId={selected?.workId} onOpenWork={openWork} onConversation={() => { setView("conversation"); requestAnimationFrame(() => composerRef.current?.focus()); }} />}
      <form hidden={Boolean(inlineWorkId)} className="bot-composer input-area" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void addAttachments(Array.from(event.dataTransfer.files)); } }} onSubmit={event => { event.preventDefault(); send(); }}>
        {view === "conversation" && awayFromBottom && <button type="button" className="bot-latest-button" onClick={followBottom}><IconChevronDown size={14} />回到最新消息</button>}
        {activeBotId && sendErrors[scopeKey] && <p className="bot-send-error" role="alert">{sendErrors[scopeKey]}</p>}
        {selected && <div className="bot-composer-context"><button type="button" onClick={() => openWork(selected.workId)}><IconListTodo size={14} /><span>当前事项：{selected.title}</span><IconChevronRight size={14} /></button><button type="button" className="bot-icon-button" aria-label="取消关联事项，返回普通对话" onClick={() => { requestedWork.current = null; setNavigationNotice(""); setSelectedWorkId(null); }}><IconX size={14} /></button></div>}
        {reference && <div className="bot-composer-context"><span>回复：{botMessageDisplayText(reference.text).slice(0, 100) || "附件消息"}</span><button type="button" aria-label="取消引用" onClick={() => setReplyReference(null)}><IconX size={14} /></button></div>}
        {pending.length > 0 && <div className="bot-pending-requests" aria-label="待确认发送的消息">{pending.map(item => <div key={item.request.requestId} className="bot-pending-request"><span>{item.request.text.slice(0, 100) || item.request.attachments?.map(file => file.name).join("、")}</span><small>{item.sending ? "正在发送" : item.error}</small>{!item.sending && ((item.error?.includes("BOT_ATTACHMENT_REJECTED:") || item.error?.includes("BOT_SELECTION_REJECTED:")) ? <button type="button" disabled={Boolean(botDraft.trim() || attachments.length)} title="先发送或清空当前草稿，再编辑这条消息" onClick={() => void submitBotDraft({ editRejectedRequestId: item.request.requestId })}>编辑重发</button> : <button type="button" onClick={() => void submitBotDraft({ retryRequestId: item.request.requestId })}>重试此消息</button>)}</div>)}</div>}
        {attachmentError && <p className="bot-send-error" role="alert">{attachmentError}</p>}
        <div className="bot-composer-box input-box">{attachments.length > 0 && <div className="input-attach-chips"><ComposerAttachmentChips attachments={attachments} onRemove={item => { if (activeBotId) useAppStore.getState().setBotAttachments(scopeKey, attachments.filter(value => value.path !== item.path)); }} /></div>}<label htmlFor="bot-draft" className="bot-sr-only">给 Bot 发消息</label><ChatComposer ref={composerRef} aria-label="给 Bot 发消息" id="bot-draft" onPaste={event => { const files = pastedComposerFiles(event.clipboardData); if (files.length) { event.preventDefault(); void addAttachments(files); } }} value={botDraft} maxLength={32000} onChange={event => setBotDraft(event.target.value)} onKeyDown={event => { if (shouldSendBotComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) { event.preventDefault(); send(); } }} placeholder={selected ? "补充要求，或问问这件事的进展…" : "说说你想做什么…"} rows={2} toolbarClassName="bot-composer-toolbar input-toolbar" toolbar={<>{activeBotId && <BotComposerCapabilities key={scopeKey} botId={activeBotId} scope={scopeKey} text={botDraft} attachmentBusy={attachmentBusy} attach={() => void addAttachments("pick")} />}<span className="bot-composer-send-actions"><button type="submit" className="bot-send-button send-btn" disabled={!canSend} aria-label="发送消息"><IconArrowUp size={17} /></button></span></>} /></div>
      </form>
    </section>
    <dialog ref={newConversationRef} className="bot-settings-dialog" aria-labelledby="bot-new-conversation-title" onCancel={event => { event.preventDefault(); if (!archiving) setNewConversationOpen(false); }}>
      <header className="bot-inspector-header"><h2 id="bot-new-conversation-title">开始新对话</h2><button type="button" className="bot-icon-button" aria-label="取消新对话" disabled={archiving} onClick={() => setNewConversationOpen(false)}><IconX size={18} /></button></header>
      <div className="bot-settings-body"><p>当前对话将归档，已创建的事项继续保留。新对话从空白上下文开始。</p>{(activeReply || pending.length > 0) && <p role="status">请先处理待发送消息，或停止仍在回复的消息，再开始新对话。已派发的后台事项不受影响。</p>}{archiveError && <p role="alert" className="bot-alert">{archiveError}</p>}
        <button type="button" disabled={archiving || Boolean(activeReply) || pending.length > 0} onClick={() => {
          if (!activeBotId) return;
          const sourceBotId = activeBotId;
          setArchiving(true); setArchiveError("");
          void useAppStore.getState().archiveBotConversation(sourceBotId, teamId).then(() => { if (useAppStore.getState().activeBotId !== sourceBotId) return; setNewConversationOpen(false); setView("conversation"); setSelectedWorkId(null); requestAnimationFrame(() => composerRef.current?.focus()); }).catch(error => setArchiveError(error instanceof Error ? error.message : "开始新对话失败，请重试。")).finally(() => setArchiving(false));
        }}>{archiving ? "正在归档…" : "归档并开始新对话"}</button><button type="button" disabled={archiving} onClick={() => setNewConversationOpen(false)}>取消</button>
      </div>
    </dialog>
    <dialog ref={settingsRef} className="bot-settings-dialog" aria-labelledby="bot-settings-title" onCancel={event => { event.preventDefault(); closeSettings(); setArchiveConfirm(false); }}>
      <header className="bot-inspector-header"><h2 id="bot-settings-title">{activeTeam ? "团队设置" : "Bot 设置与对话管理"}</h2><button type="button" className="bot-icon-button" aria-label={activeTeam ? "关闭团队设置" : "关闭 Bot 设置"} onClick={() => { closeSettings(); setArchiveConfirm(false); }}><IconX size={18} /></button></header>
      <div className="bot-settings-body">{activeTeam ? <><BotTeamSettings key={activeTeam.templateId} team={activeTeam} onCancel={() => closeSettings()} onSaved={team => { window.dispatchEvent(new CustomEvent("mybuddy:team-updated", { detail: team })); if (currentScope.current !== scopeKey || settingsEpoch.current !== renderedSettingsEpoch) return; useAppStore.getState().setActiveTeam(team); closeSettings(); }} />{settingsOpen && <ScopedMemoryPanel key={activeTeam.templateId} scopeType="team" scopeId={activeTeam.templateId} title="团队记忆" />}<details className="bot-advanced"><summary>团队管理与回收站</summary><BotTeamManagement team={activeTeam} onChanged={() => { window.dispatchEvent(new Event("mybuddy:teams-refresh")); void useAppStore.getState().refreshBotWork(true); }} /></details></> : <>{activeBot && <section className="bot-settings-identity" aria-label="Bot 身份与职责"><h3>{activeBot.displayName}</h3><BotRename key={activeBot.botId} bot={activeBot} /><p>{activeBot.responsibilitySummary || "尚未设置具体职责。你可以在对话中说明这次希望它协助的目标。"}</p><p>独立 Bot 身份。当前使用已生效的模型、工具与工作区配置。</p></section>}{activeBot && <><BotExecutionSettings key={`settings-${activeBot.botId}-${settingsOpen}`} botId={activeBot.botId} onManageModels={() => { closeSettings(); setArchiveConfirm(false); }} /><details className="bot-advanced"><summary>专家配置</summary><BotExpertReview botId={activeBot.botId} /></details>
<BotDeletion bot={activeBot} onDeleted={() => closeSettings()} /><section className="bot-archive-section">{archiveError && <p role="alert" className="bot-alert">{archiveError}</p>}<h3>归档当前对话</h3><p>收起这段对话，开始新的聊天。事项记录仍会保留。</p>{archiveConfirm ? <div role="group" aria-label="确认归档"><p>确定归档当前对话吗？</p><button type="button" disabled={archiving || Boolean(activeReply) || pending.length > 0} title={activeReply || pending.length ? "仍有前台消息未结束，请先处理对应消息" : undefined} onClick={() => { setArchiving(true); setArchiveError(""); void useAppStore.getState().archiveBotConversation(activeBot.botId).then(() => { setArchiveConfirm(false); closeSettings(); }).catch(error => setArchiveError(error instanceof Error ? error.message : "归档未完成，请稍后重试。")).finally(() => setArchiving(false)); }}>{archiving ? "正在归档…" : "确认归档"}</button><button type="button" disabled={archiving} onClick={() => setArchiveConfirm(false)}>取消</button></div> : <button type="button" onClick={() => setArchiveConfirm(true)}><IconArchive size={15} />归档对话</button>}</section></>}</>}{settingsOpen && histories[scopeKey]?.conversationId && <ScopedMemoryPanel key={histories[scopeKey].conversationId} scopeType="conversation" scopeId={histories[scopeKey].conversationId!} title="本次对话记忆" />}</div>
    </dialog>
  </div>;
}

// Default shallow memo compares every prop. Bind per-message actions inside
// BotMessage, so unchanged rows need neither new callbacks nor another component.
const ignoreMessageCancel = () => {};
const TimelineMessage = memo(BotMessage);

export function BotMessage({ message, botName, works, onOpenWork, onCancel, sourceQuestion, workLinkSource, onReply }: { workLinkSource?: BotMessageDto; sourceQuestion?: BotMessageDto; onReply?: (message: BotMessageDto) => void; message: BotMessageDto; botName: string; works: WorkProjectionDto[]; onOpenWork: (id: string) => void; onCancel: (message: BotMessageDto) => void }): React.JSX.Element {
  const externalTask = useAppStore(state => state.tasks.find(task => task.id === botExternalAgentTaskId(message.messageId)));
  // Replace trusted image destinations before Markdown parsing: raw Windows
  // backslashes (e.g. \.mybuddy) otherwise become Markdown escapes.
  const renderMarkdown = (text: string, streaming = message.status === "running") => <ChatImageScope taskId={message.reportImages?.taskId ?? null} artifacts={message.reportImages?.artifacts ?? []} sources={message.reportImages?.sources ?? {}}><ChatMarkdown resolveTaskFiles={false} text={rewriteMarkdownImageSources(text, source => {
    const id = message.reportImages?.sources[source];
    const image = message.reportImages?.artifacts.find(item => item.id === id);
    return image ? artifactImageUrl(image.id, "full", { version: image.version }) : source;
  })} streaming={streaming} /></ChatImageScope>;
  const linkedWorkIds = botMessageWorkLinks(message, workLinkSource ?? sourceQuestion);
  const result = message.role === "assistant" && message.status === "completed" && message.workFeedback?.report
    && (message.workFeedback.kind === "result" || (message.workFeedback.kind === "binding"
      && message.workFeedback.category === "progress" && message.workFeedback.report.milestone));
  const running = message.role === "assistant" && ["queued", "running", "unknown"].includes(message.status);
  const nonemptySegments = message.segments?.filter(segment => segment.text.trim()) ?? [];
  const hasModelText = Boolean(message.text.trim()) || nonemptySegments.some(segment => segment.kind !== "receipt");
  const segments = nonemptySegments.filter(segment => segment.kind !== "receipt" || !hasModelText);
  const receiptOnly = segments.length > 0 && !hasModelText;
  const showActivity = running && !(receiptOnly && !message.activity && message.status !== "unknown");
  const hasContent = Boolean(message.text) || segments.length > 0;
  return <article className={`bot-message msg-row ${message.role}`} data-message-id={message.messageId} data-streaming={message.role === "assistant" && message.status === "running" ? "true" : undefined} aria-label={`${message.role === "user" ? "你" : botName}的消息`}>
    {message.role === "assistant" && <div className="bot-message-author"><span className="bot-avatar" aria-hidden="true"><IconBot size={16} /></span><strong>{botName}</strong></div>}
    {message.role === "assistant" && sourceQuestion && !message.workFeedback && <div className="bot-reply-reference" aria-label="回复对应问题">回复：{botMessageDisplayText(sourceQuestion.text) || sourceQuestion.attachments?.map(item => item.name).join("、")}</div>}
    {message.role === "user" ? <div className="user-bubble">{Boolean(message.attachments?.length) && <div className="input-attach-chips"><ComposerAttachmentChips attachments={message.attachments ?? []} /></div>}{message.text && <div className="user-bubble-text">{botMessageDisplayText(message.text)}</div>}</div> : <div className="bot-assistant-content">
      {result && message.text ? <BotResultReport message={message} work={works.find(work => work.workId === message.workFeedback?.workId)} renderMarkdown={renderMarkdown} />
        : segments.length > 0 ? segments.map((segment, index) => <div key={segment.id} data-segment-id={segment.id} data-segment-kind={segment.kind} aria-label={segment.kind === "receipt" ? "消息回执" : undefined} className={`bot-reply-segment bot-reply-segment-${segment.kind}`}>
          {renderMarkdown(segment.text, message.status === "running" && segment.kind === "answer" && index === segments.length - 1)}
        </div>) : message.text ? renderMarkdown(message.text) : null}
      {(showActivity || !hasContent) && <p className="bot-reply-placeholder" role={running ? "status" : undefined}>{message.status === "completed" ? "没有文本回复" : botMessageStatus(message)}{running && <span className="bot-typing-dots" aria-hidden="true">···</span>}</p>}
    </div>}
    {linkedWorkIds.length > 0 && <div className="bot-message-work-links">{linkedWorkIds.map(workId => <button type="button" key={workId} onClick={() => onOpenWork(workId)}><IconListTodo size={14} /><span>{works.find(work => work.workId === workId)?.title ?? (message.workFeedback?.workId === workId ? message.workFeedback.report?.title : undefined) ?? "查看关联事项"}</span><IconChevronRight size={14} /></button>)}</div>}
    {externalTask && <div className="bot-message-work-links"><button type="button" onClick={() => useAppStore.getState().setActiveTask(externalTask.id)}><IconBot size={14} /><span>打开外部 Agent 任务</span><IconChevronRight size={14} /></button></div>}
    {message.role === "assistant" && <BotCallThread calls={message.botCalls} renderReply={renderMarkdown} />}
    <BotReplyMetrics message={message} />
    <BotMessageActions message={message} onReply={onReply ? () => onReply(message) : undefined} onCancel={() => onCancel(message)} statusAlreadyVisible={message.role === "assistant" && (showActivity || !hasContent) && message.status !== "completed"} />
    {message.error && <p className="bot-alert" role="alert">{message.error}</p>}
  </article>;
}
