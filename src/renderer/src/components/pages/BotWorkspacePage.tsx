import { useBotThreadScroll } from "@/hooks/useBotThreadScroll";
import { BotComposerCapabilities } from "./BotComposerCapabilities";
import { BotWorkConversationDetail } from "./BotWorkConversationDetail";
import { BotMessageActions } from "./BotMessageActions";
import { BotRename } from "./BotRename";
import { BotTeamManagement } from "./BotTeamManagement";
import { BotTeamSettings } from "./BotTeamSettings";
import { botConversationScope } from "@/store/app/slices/botConversation";
import { BotWorkNavigation } from "./BotWorkNavigation";
import { ComposerAttachmentChips } from "@/components/chat/ComposerAttachmentChips";
import { composerFiles, mergeComposerAttachments, pastedComposerFiles, pickComposerAttachment } from "@/components/chat/composerAttachments";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BotDto, WorkProjectionDto } from "@shared/bot-work";
import type { BotMessageDto } from "@shared/bot-conversation";
import type { BotWorkHostStatusDto } from "@shared/bot-work-ipc";
import { useAppStore } from "@/store/appStore";
import { rewriteMarkdownImageSources } from "@shared/markdown-images";
import { artifactImageUrl } from "@shared/artifact-ipc";
import { ChatImageScope } from "@/components/chat/ChatImage";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatMarkdown from "@/components/chat/ChatMarkdown";
import { IconPlus, IconArchive, IconChevronDown, IconArrowUp, IconBot, IconChevronRight, IconListTodo, IconPanel, IconSettings, IconX } from "@/components/common/icons";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { activeBotReply, personalBotWork, botMessageStatus, botWorkTimeline, shouldSendBotComposer, type BotWorkspaceView } from "@/lib/botWorkspacePresentation";
import { BotWorkBrowser } from "./BotWorkBrowser";
import { BotWorkDetails } from "./BotWorkDetails";
import { BotResultReport } from "./BotWorkResult";
import { BotActivityMonitor } from "./BotActivityMonitor";
import { BotWorkspaceAuthorization } from "./BotWorkspaceAuthorization";
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
  const sendErrors = useAppStore(s => s.botConversationErrors);
  const pendingSends = useAppStore(s => s.botPendingSends);
  const identities = useAppStore(s => s.botIdentities);
  const works = useAppStore(s => s.botWorks);
  const activeBotId = useAppStore(s => s.activeBotId);
  const activeTeam = useAppStore(s => s.activeTeam);
  const teamId = activeTeam?.templateId;
  const scopeKey = activeBotId ? botConversationScope(activeBotId, teamId) : "";
  const selectedWorkId = useAppStore(s => s.selectedWorkId);
  const setSelectedWorkId = useAppStore(s => s.setSelectedWorkId);
  const hostStatus = useAppStore(s => s.botHostStatus);
  const workError = useAppStore(s => s.botWorkError);
  const allWorksLoaded = useAppStore(s => s.botWorkCursor?.scope === "all");
  const [includeClosed, setIncludeClosed] = useState(allWorksLoaded);
  const [view, setView] = useState<BotWorkspaceView>("conversation");
  const compact = useMediaQuery("(max-width: 1180px)");
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(selectedWorkId));
  const suppressAutoInline = useRef(false);
  const [inlineWorkId, setInlineWorkId] = useState<string | null>(null);
  const returnTarget = useRef<{ scope: string; conversationId?: string; scrollTop: number; follow: boolean; trigger: HTMLElement | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const requestedWork = useRef<string | null>(null);
  const [pendingWorkId, setPendingWorkId] = useState<string | null>(null);
  const pendingWorkOpen = useRef<{ workId: string; scope: string; conversationId?: string; show: () => void } | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const inspectorRef = useRef<HTMLDialogElement>(null);
  const settingsRef = useRef<HTMLDialogElement>(null);
  const settingsEpoch = useRef(0);
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const renderedSettingsEpoch = settingsEpoch.current;
  const closeSettings = () => { settingsEpoch.current++; setSettingsOpen(false); };
  const newConversationRef = useRef<HTMLDialogElement>(null);
  const lastBot = useRef(scopeKey);
  const activeBot = identities.find(bot => bot.botId === activeBotId) ?? null;
  const botWorks = useMemo(() => works.filter(work => !work.team?.removedAt && (teamId ? work.team?.teamId === teamId : personalBotWork(work, activeBotId))), [works, activeBotId, teamId]);
  const displayName = activeTeam?.name ?? activeBot?.displayName ?? "Bot";
  const inlineWork = botWorks.find(work => work.workId === inlineWorkId) ?? null;
  const selected = botWorks.find(work => work.workId === selectedWorkId) ?? null;
  const messages = activeBotId ? histories[scopeKey]?.messages ?? [] : [];
  const questionsByRequest = useMemo(() => new Map(messages.filter(item => item.role === "user").map(item => [item.requestId, item])), [messages]);
  const activeReply = activeBotReply(messages);
  const { followLatest, awayFromBottom, pauseFollowing, restoreScroll, followBottom } = useBotThreadScroll(
    threadRef, `${scopeKey}:${histories[scopeKey]?.conversationId ?? ""}`,
    view === "conversation" && !inlineWorkId, messages,
  );
  const pending = Object.values(pendingSends).filter(item => item.request.botId === activeBotId && item.request.teamId === teamId);
  const runningReplies = messages.filter(item => item.role === "assistant" && item.status === "running");
  const queuedReplies = messages.filter(item => item.role === "assistant" && item.status === "queued");
  const [replyReference, setReplyReference] = useState<BotMessageDto | null>(null);
  const reference = replyReference?.conversationId === histories[scopeKey]?.conversationId ? replyReference : null;
  const attachments = activeBotId ? attachmentDrafts[scopeKey] ?? [] : [];
  const canSend = Boolean(activeBotId && (botDraft.trim() || attachments.length) && !attachmentBusy);
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
    requestedWork.current = null; pendingWorkOpen.current = null; setNavigationNotice(""); setInlineWorkId(null); returnTarget.current = null;
    setView("conversation"); closeSettings(); setArchiveConfirm(false); setNewConversationOpen(false); setInspectorOpen(false);
  }, [scopeKey]);
  useEffect(() => {
    if (suppressAutoInline.current) { suppressAutoInline.current = false; return; }
    if (!selected || inlineWorkId === selected.workId) return;
    if (view !== "conversation") { setInspectorOpen(true); return; }
    // Menu and cross-Bot/team navigation set selection in the store. Consume it
    // only after this render has resolved the target scope, not in a stale callback.
    returnTarget.current = { scope: scopeKey, conversationId: histories[scopeKey]?.conversationId,
      scrollTop: threadRef.current?.scrollTop ?? 0, follow: followLatest.current,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    setNavigationNotice("");
    pauseFollowing(); setIncludeClosed(true);
    setInlineWorkId(selected.workId); setInspectorOpen(false);
  }, [selected?.workId, scopeKey, view]);
  useEffect(() => {
    const dialog = inspectorRef.current;
    if (!dialog) return;
    if (inlineWorkId || !inspectorOpen || !selected) { if (dialog.open) dialog.close(); return; }
    // The same mounted details tree survives resizing. Only the native dialog mode changes.
    if (dialog.open) dialog.close();
    if (compact) dialog.showModal(); else dialog.show();
    return () => { if (dialog.open) dialog.close(); };
  }, [inspectorOpen, Boolean(selected), compact, inlineWorkId]);
  useEffect(() => {
    const dialog = settingsRef.current;
    if (settingsOpen) dialog?.showModal(); else if (dialog?.open) dialog.close();
  }, [settingsOpen]);
  useEffect(() => {
    const dialog = newConversationRef.current;
    if (newConversationOpen) dialog?.showModal(); else if (dialog?.open) dialog.close();
  }, [newConversationOpen]);
  useEffect(() => {
    const body = inspectorRef.current?.querySelector(".bot-inspector-body");
    if (body) body.scrollTop = 0;
  }, [selected?.workId]);


  const returnToConversation = () => {
    const target = returnTarget.current;
    requestedWork.current = null; pendingWorkOpen.current = null;
    setInlineWorkId(null); setInspectorOpen(false); setSelectedWorkId(null);
    setNavigationNotice("");
    requestAnimationFrame(() => {
      if (target?.scope !== currentScope.current || target.conversationId !== useAppStore.getState().botHistories[target.scope]?.conversationId) return;
      restoreScroll(target.scrollTop, target.follow);
      if (target.trigger?.isConnected) target.trigger.focus({ preventScroll: true });
    });
  };
  const openWork = (workId: string) => {
    suppressAutoInline.current = false;
    const sourceScope = scopeKey;
    const sourceConversation = histories[sourceScope]?.conversationId;
    const inline = view === "conversation";
    const target = { scope: sourceScope, conversationId: sourceConversation,
      scrollTop: threadRef.current?.scrollTop ?? 0, follow: followLatest.current,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    const show = () => {
      setSelectedWorkId(workId);
      if (inline) {
        setIncludeClosed(true); // Keep a selected Work visible when it finishes during reading.
        returnTarget.current = target; pauseFollowing();
        setInlineWorkId(workId); setInspectorOpen(false);
      } else { setInlineWorkId(null); setInspectorOpen(true); }
      setNavigationNotice("");
    };
    // Resolve only within the current Bot/team. Never let a late history fetch
    // open another team's work after navigation or a new conversation.
    requestedWork.current = workId; pendingWorkOpen.current = null;
    if (botWorks.some(work => work.workId === workId)) { show(); return; }
    pendingWorkOpen.current = { workId, scope: sourceScope, conversationId: sourceConversation, show };
    setPendingWorkId(workId);
    setIncludeClosed(true); setNavigationNotice("正在读取关联事项…");
    // A refresh promise may resolve before its replacement snapshot is installed.
    // Navigate from the actual all-scope projection, not a superseded response.
    void useAppStore.getState().refreshBotWork(true);
  };
  useEffect(() => {
    const pending = pendingWorkOpen.current;
    if (!pending || !allWorksLoaded) return;
    if (requestedWork.current !== pending.workId || pending.scope !== scopeKey ||
      histories[scopeKey]?.conversationId !== pending.conversationId) { pendingWorkOpen.current = null; return; }
    pendingWorkOpen.current = null; setPendingWorkId(null);
    if (botWorks.some(work => work.workId === pending.workId)) pending.show();
    else setNavigationNotice("暂时无法打开此事项，可能已删除或不属于当前对话。");
  }, [botWorks, allWorksLoaded, scopeKey, histories[scopeKey]?.conversationId, pendingWorkId]);
  const changeView = (next: BotWorkspaceView) => {
    requestedWork.current = null; setNavigationNotice("");
    setInlineWorkId(null); setInspectorOpen(false);
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
    const quote = `${marker}\n事项：${work.title}\n查看版本：要求 r${work.intentRevision}，负责人代次 ${work.ownerEpoch}，状态 v${work.stateVersion}\n原问题：${blocker.reason}\n我的回复：\n\n请先核对当前状态和这条回复；不要把回复本身当作授权或重跑整个任务的许可。`;
    const draft = existing.includes(marker) ? existing : [existing, quote].filter(Boolean).join("\n\n");
    if (draft.length > 32000) { setNavigationNotice("现有草稿较长，请先整理后再引用问题。没有覆盖或发送任何内容。"); return; }
    // setActiveBotId retains the previous Bot's draft and restores the owner's.
    if (state.activeBotId !== owner.botId) state.setActiveBotId(owner.botId);
    suppressAutoInline.current = true;
    state.setSelectedWorkId(work.workId); state.setBotDraft(draft);
    setView("conversation"); setInspectorOpen(false);
    requestAnimationFrame(() => { setInspectorOpen(false); composerRef.current?.focus(); });
  };

  return <div className="bot-workspace" onKeyDownCapture={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { setInspectorOpen(false); closeSettings(); } }}>
    <section className="bot-conversation" aria-label="Bot 对话">
      <header className="bot-workspace-header" hidden={Boolean(inlineWorkId)}>
        {props.onToggleNavigation && <button type="button" className="bot-icon-button" aria-label={props.navigationVisible ? "收起导航" : "展开导航"} aria-expanded={props.navigationVisible} onClick={props.onToggleNavigation}><IconPanel size={18} /></button>}
        <span className="bot-avatar bot-header-avatar" aria-hidden="true"><IconBot size={21} /></span>
        <div className="bot-heading"><h1>{activeTeam?.name ?? activeBot?.displayName ?? "Bot 模式"}</h1><p><span className={`bot-presence ${hostStatus?.online && activeBot?.status === "active" ? "is-online" : ""}`} />{activeBot ? presenceLabel(activeBot, hostStatus) : "你的长期个人助理"}<span className="bot-heading-description"> · {activeTeam ? `团队工作台 · ${activeTeam.members.length + 1} 位成员` : "对话有延续，事项有着落"}</span></p></div>
        <div className="bot-workspace-actions">
          <button type="button" className="bot-quiet-button bot-new-conversation" disabled={!activeBot} onClick={() => {
            setArchiveError("");
            if (messages.length === 0) {
              setView("conversation"); setSelectedWorkId(null); setInspectorOpen(false);
              requestAnimationFrame(() => composerRef.current?.focus());
              return;
            }
            setNewConversationOpen(true);
          }}>新对话</button>
          <BotActivityMonitor onOpenWork={() => { suppressAutoInline.current = false; setIncludeClosed(true); setInspectorOpen(true); }} onOpenBotMessage={messageId => {
            pauseFollowing();
            setView("conversation"); setInspectorOpen(false);
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const node = Array.from(threadRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []).find(item => item.dataset.messageId === messageId);
              node?.scrollIntoView({ block: "center" });
            }));
          }} />
          <button type="button" className="bot-icon-button" aria-label={activeTeam ? "团队设置与管理" : "Bot 设置与对话管理"} onClick={() => { settingsEpoch.current++; setSettingsOpen(true); }}><IconSettings size={18} /></button>
        </div>
      </header>
      {!inlineWorkId && <BotWorkNavigation works={botWorks} view={view} allWorksLoaded={allWorksLoaded} onChange={changeView} />}
      {workError && <p className="bot-alert" role="alert">{workError}</p>}
      {navigationNotice && <p className="bot-navigation-notice" role="status">{navigationNotice}</p>}
      {inlineWorkId && <BotWorkConversationDetail work={inlineWork} conversationName={displayName}
        ownerName={inlineWork?.team?.teamId ? displayName : identities.find(bot => bot.botId === inlineWork?.ownerBotId)?.displayName ?? displayName}
        includeClosed={includeClosed} onBack={returnToConversation}
        onReplyToBlocker={blocker => { if (inlineWork) { returnToConversation(); replyToBlocker(inlineWork, blocker); } }} />}
      {view === "conversation" ? <>
        <div className="bot-thread" hidden={Boolean(inlineWorkId)} ref={threadRef} role="log" aria-label="对话记录" aria-live="off" tabIndex={0}>
          {messages.length === 0 ? <div className="bot-conversation-empty">
            <span className="bot-welcome-icon" aria-hidden="true"><IconBot size={30} /></span>
            <span className="bot-eyebrow">从一句话开始</span>
            <h2>{activeBot ? "有什么想一起推进的？" : "还没有 Bot"}</h2>
            <p>{activeBot ? "聊想法、交代事项，或继续上次的进展。普通聊天不会自动创建事项。" : "创建一个 Bot，给它名称和职责，就能开始独立的对话。"}</p>
            {!activeBot && props.onCreateBot && <button type="button" className="bot-empty-create" onClick={props.onCreateBot}>创建第一个 Bot</button>}
            {activeBot && <div className="bot-example-grid">{examples.map(example => <button type="button" key={example.title} onClick={() => draftExample(example.text)}><span>{example.title}</span><IconArrowUp size={16} /></button>)}</div>}
          </div> : <div className="bot-message-list">{botWorkTimeline(messages).map(row => row.kind === "message"
            ? <BotMessage key={row.key} message={row.message} botName={displayName} works={botWorks} onOpenWork={openWork} sourceQuestion={questionsByRequest.get(row.message.requestId)} onReply={() => { setReplyReference(row.message); composerRef.current?.focus(); }} onCancel={() => { if (activeBotId) void useAppStore.getState().cancelBotSend(row.message.botId, row.message.requestId); }} />
            : <details key={row.key} className="bot-work-progress" aria-label="事项进展记录">
              <summary>{row.workIds.length > 1 ? `${row.workIds.length} 个事项` : botWorks.find(work => work.workId === row.workId)?.title ?? "事项"} · {row.messages.length} 条执行记录（展开查看）</summary>
              {row.messages.map(message => <BotMessage key={message.messageId} message={message} botName={displayName} works={botWorks} onOpenWork={openWork} onCancel={() => {}} />)}
            </details>)}</div>}
        </div>
      </> : <BotWorkBrowser key={`${activeBotId}-${view}`} works={botWorks} view={view} loading={(view === "closed" || view === "completed") && !allWorksLoaded} selectedWorkId={selected?.workId} onOpenWork={openWork} onConversation={() => { setView("conversation"); requestAnimationFrame(() => composerRef.current?.focus()); }} />}
      <form hidden={Boolean(inlineWorkId)} className="bot-composer input-area" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void addAttachments(Array.from(event.dataTransfer.files)); } }} onSubmit={event => { event.preventDefault(); send(); }}>
        {view === "conversation" && awayFromBottom && <button type="button" className="bot-latest-button" onClick={followBottom}><IconChevronDown size={14} />回到最新消息</button>}
        {activeBotId && sendErrors[scopeKey] && <p className="bot-send-error" role="alert">{sendErrors[scopeKey]}</p>}
        {selected && <div className="bot-composer-context"><button type="button" onClick={() => openWork(selected.workId)}><IconListTodo size={14} /><span>当前事项：{selected.title}</span><IconChevronRight size={14} /></button><button type="button" className="bot-icon-button" aria-label="取消关联事项，返回普通对话" onClick={() => { requestedWork.current = null; setNavigationNotice(""); setSelectedWorkId(null); setInspectorOpen(false); }}><IconX size={14} /></button></div>}
        {reference && <div className="bot-composer-context"><span>回复：{reference.text.slice(0, 100) || "附件消息"}</span><button type="button" aria-label="取消引用" onClick={() => setReplyReference(null)}><IconX size={14} /></button></div>}
        {pending.length > 0 && <div className="bot-pending-requests" aria-label="待确认发送的消息">{pending.map(item => <div key={item.request.requestId} className="bot-pending-request"><span>{item.request.text.slice(0, 100) || item.request.attachments?.map(file => file.name).join("、")}</span><small>{item.sending ? "正在发送" : item.error}</small>{!item.sending && ((item.error?.includes("BOT_ATTACHMENT_REJECTED:") || item.error?.includes("BOT_SELECTION_REJECTED:")) ? <button type="button" disabled={Boolean(botDraft.trim() || attachments.length)} title="先发送或清空当前草稿，再编辑这条消息" onClick={() => void submitBotDraft({ editRejectedRequestId: item.request.requestId })}>编辑重发</button> : <button type="button" onClick={() => void submitBotDraft({ retryRequestId: item.request.requestId })}>重试此消息</button>)}</div>)}</div>}
        {attachmentError && <p className="bot-send-error" role="alert">{attachmentError}</p>}
        <div className="bot-composer-box input-box">{attachments.length > 0 && <div className="input-attach-chips"><ComposerAttachmentChips attachments={attachments} onRemove={item => { if (activeBotId) useAppStore.getState().setBotAttachments(scopeKey, attachments.filter(value => value.path !== item.path)); }} /></div>}<label htmlFor="bot-draft" className="bot-sr-only">给 Bot 发消息</label><ChatComposer ref={composerRef} aria-label="给 Bot 发消息" id="bot-draft" onPaste={event => { const files = pastedComposerFiles(event.clipboardData); if (files.length) { event.preventDefault(); void addAttachments(files); } }} value={botDraft} maxLength={32000} onChange={event => setBotDraft(event.target.value)} onKeyDown={event => { if (shouldSendBotComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) { event.preventDefault(); send(); } }} placeholder={selected ? "补充要求，或问问这件事的进展…" : "说说你想做什么…"} rows={2} toolbarClassName="bot-composer-toolbar input-toolbar" toolbar={<>{activeBotId && <BotComposerCapabilities key={scopeKey} botId={activeBotId} scope={scopeKey} text={botDraft} attachmentBusy={attachmentBusy} attach={() => void addAttachments("pick")} />}<span className="bot-composer-send-actions"><button type="submit" className="bot-send-button send-btn" disabled={!canSend} aria-label="发送消息"><IconArrowUp size={17} /></button></span></>} /></div>
      </form>
    </section>
    {selected && !inlineWorkId && <dialog ref={inspectorRef} className={`bot-inspector ${compact ? "is-drawer" : view === "conversation" ? "is-overlay" : ""}`} aria-label="事项详情" onCancel={event => { event.preventDefault(); setInspectorOpen(false); }} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right) setInspectorOpen(false); } }}>
      <header className="bot-inspector-header"><span>事项详情</span><button type="button" className="bot-icon-button" aria-label="关闭详情" onClick={() => setInspectorOpen(false)}><IconX size={18} /></button></header>
      <div className="bot-inspector-body"><BotWorkDetails key={selected.workId} work={selected} ownerName={activeTeam?.name ?? identities.find(bot => bot.botId === selected.ownerBotId)?.displayName ?? selected.ownerBotId} includeClosed={includeClosed} onReplyToBlocker={blocker => replyToBlocker(selected, blocker)} /></div>
    </dialog>}
    <dialog ref={newConversationRef} className="bot-settings-dialog" aria-labelledby="bot-new-conversation-title" onCancel={event => { event.preventDefault(); if (!archiving) setNewConversationOpen(false); }}>
      <header className="bot-inspector-header"><h2 id="bot-new-conversation-title">开始新对话</h2><button type="button" className="bot-icon-button" aria-label="取消新对话" disabled={archiving} onClick={() => setNewConversationOpen(false)}><IconX size={18} /></button></header>
      <div className="bot-settings-body"><p>当前对话将归档，已创建的事项继续保留。新对话从空白上下文开始。</p>{(activeReply || pending.length > 0) && <p role="status">请先处理待发送消息，或停止仍在回复的消息，再开始新对话。已派发的后台事项不受影响。</p>}{archiveError && <p role="alert" className="bot-alert">{archiveError}</p>}
        <button type="button" disabled={archiving || Boolean(activeReply) || pending.length > 0} onClick={() => {
          if (!activeBotId) return;
          const sourceBotId = activeBotId;
          setArchiving(true); setArchiveError("");
          void useAppStore.getState().archiveBotConversation(sourceBotId, teamId).then(() => { if (useAppStore.getState().activeBotId !== sourceBotId) return; setNewConversationOpen(false); setView("conversation"); setSelectedWorkId(null); setInspectorOpen(false); requestAnimationFrame(() => composerRef.current?.focus()); }).catch(error => setArchiveError(error instanceof Error ? error.message : "开始新对话失败，请重试。")).finally(() => setArchiving(false));
        }}>{archiving ? "正在归档…" : "归档并开始新对话"}</button><button type="button" disabled={archiving} onClick={() => setNewConversationOpen(false)}>取消</button>
      </div>
    </dialog>
    <dialog ref={settingsRef} className="bot-settings-dialog" aria-labelledby="bot-settings-title" onCancel={event => { event.preventDefault(); closeSettings(); setArchiveConfirm(false); }}>
      <header className="bot-inspector-header"><h2 id="bot-settings-title">{activeTeam ? "团队设置" : "Bot 设置与对话管理"}</h2><button type="button" className="bot-icon-button" aria-label={activeTeam ? "关闭团队设置" : "关闭 Bot 设置"} onClick={() => { closeSettings(); setArchiveConfirm(false); }}><IconX size={18} /></button></header>
      <div className="bot-settings-body">{activeTeam ? <><BotTeamSettings key={activeTeam.templateId} team={activeTeam} onCancel={() => closeSettings()} onSaved={team => { window.dispatchEvent(new CustomEvent("mybuddy:team-updated", { detail: team })); if (currentScope.current !== scopeKey || settingsEpoch.current !== renderedSettingsEpoch) return; useAppStore.getState().setActiveTeam(team); closeSettings(); }} /><details className="bot-advanced"><summary>团队管理与回收站</summary><BotTeamManagement team={activeTeam} onChanged={() => { window.dispatchEvent(new Event("mybuddy:teams-refresh")); void useAppStore.getState().refreshBotWork(true); }} /></details></> : <>{activeBot && <section className="bot-settings-identity" aria-label="Bot 身份与职责"><h3>{activeBot.displayName}</h3><BotRename key={activeBot.botId} bot={activeBot} /><p>{activeBot.responsibilitySummary || "尚未设置具体职责。你可以在对话中说明这次希望它协助的目标。"}</p><p>独立 Bot 身份。当前配置与操作范围以已生效的版本及授权为准。</p></section>}{activeBot && <><BotExecutionSettings key={`settings-${activeBot.botId}-${settingsOpen}`} botId={activeBot.botId} onManageModels={() => { closeSettings(); setArchiveConfirm(false); }} /><BotWorkspaceAuthorization key={activeBot.botId} bot={activeBot} /><details className="bot-advanced"><summary>专家配置与权限审阅</summary><BotExpertReview botId={activeBot.botId} /></details>
<BotDeletion bot={activeBot} onDeleted={() => closeSettings()} /><section className="bot-archive-section">{archiveError && <p role="alert" className="bot-alert">{archiveError}</p>}<h3>归档当前对话</h3><p>收起这段对话，开始新的聊天。事项记录仍会保留。</p>{archiveConfirm ? <div role="group" aria-label="确认归档"><p>确定归档当前对话吗？</p><button type="button" disabled={archiving || Boolean(activeReply) || pending.length > 0} title={activeReply || pending.length ? "仍有前台消息未结束，请先处理对应消息" : undefined} onClick={() => { setArchiving(true); setArchiveError(""); void useAppStore.getState().archiveBotConversation(activeBot.botId).then(() => { setArchiveConfirm(false); closeSettings(); }).catch(error => setArchiveError(error instanceof Error ? error.message : "归档未完成，请稍后重试。")).finally(() => setArchiving(false)); }}>{archiving ? "正在归档…" : "确认归档"}</button><button type="button" disabled={archiving} onClick={() => setArchiveConfirm(false)}>取消</button></div> : <button type="button" onClick={() => setArchiveConfirm(true)}><IconArchive size={15} />归档对话</button>}</section></>}</>}</div>
    </dialog>
  </div>;
}

export function BotMessage({ message, botName, works, onOpenWork, onCancel, sourceQuestion, onReply }: { sourceQuestion?: BotMessageDto; onReply?: () => void; message: BotMessageDto; botName: string; works: WorkProjectionDto[]; onOpenWork: (id: string) => void; onCancel: () => void }): React.JSX.Element {
  // Replace trusted image destinations before Markdown parsing: raw Windows
  // backslashes (e.g. \.mybuddy) otherwise become Markdown escapes.
  const renderMarkdown = (text: string) => <ChatImageScope taskId={message.reportImages?.taskId ?? null} artifacts={message.reportImages?.artifacts ?? []} sources={message.reportImages?.sources ?? {}}><ChatMarkdown resolveTaskFiles={false} text={rewriteMarkdownImageSources(text, source => {
    const id = message.reportImages?.sources[source];
    const image = message.reportImages?.artifacts.find(item => item.id === id);
    return image ? artifactImageUrl(image.id, "full", { version: image.version }) : source;
  })} streaming={message.status === "running"} /></ChatImageScope>;
  const result = message.role === "assistant" && message.status === "completed" && message.workFeedback?.kind === "result" && message.workFeedback.report;
  const running = message.role === "assistant" && ["queued", "running", "unknown"].includes(message.status);
  return <article className={`bot-message msg-row ${message.role}`} data-message-id={message.messageId} data-streaming={message.role === "assistant" && message.status === "running" ? "true" : undefined} aria-label={`${message.role === "user" ? "你" : botName}的消息`}>
    {message.role === "assistant" && <div className="bot-message-author"><span className="bot-avatar" aria-hidden="true"><IconBot size={16} /></span><strong>{botName}</strong></div>}
    {message.role === "assistant" && sourceQuestion && !message.workFeedback && <div className="bot-reply-reference" aria-label="回复对应问题">回复：{sourceQuestion.text || sourceQuestion.attachments?.map(item => item.name).join("、")}</div>}
    {message.role === "user" ? <div className="user-bubble">{Boolean(message.attachments?.length) && <div className="input-attach-chips"><ComposerAttachmentChips attachments={message.attachments ?? []} /></div>}{message.text && <div className="user-bubble-text">{message.text}</div>}</div> : <div className="bot-assistant-content">{message.text ? <>{result ? <BotResultReport message={message} work={works.find(work => work.workId === message.workFeedback?.workId)} renderMarkdown={renderMarkdown} /> : renderMarkdown(message.text)}</> : <p className="bot-reply-placeholder" role={running ? "status" : undefined}>{message.status === "completed" ? "没有文本回复" : botMessageStatus(message)}{running && <span className="bot-typing-dots" aria-hidden="true">···</span>}</p>}</div>}
    {message.workIds.length > 0 && <div className="bot-message-work-links">{message.workIds.map(workId => <button type="button" key={workId} onClick={() => onOpenWork(workId)}><IconListTodo size={14} /><span>{works.find(work => work.workId === workId)?.title ?? (message.workFeedback?.workId === workId ? message.workFeedback.report?.title : undefined) ?? "查看关联事项"}</span><IconChevronRight size={14} /></button>)}</div>}
    <BotMessageActions message={message} onReply={onReply} onCancel={onCancel} />
    {message.error && <p className="bot-alert" role="alert">{message.error}</p>}
  </article>;
}
