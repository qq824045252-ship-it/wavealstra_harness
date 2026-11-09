import { ComposerAttachmentChips } from "@/components/chat/ComposerAttachmentChips";
import { composerFiles, mergeComposerAttachments, pastedComposerFiles, pickComposerAttachment } from "@/components/chat/composerAttachments";
import { useEffect, useRef, useState } from "react";
import type { BotDto, WorkProjectionDto } from "@shared/bot-work";
import type { BotMessageDto } from "@shared/bot-conversation";
import type { BotWorkHostStatusDto } from "@shared/bot-work-ipc";
import { useAppStore } from "@/store/appStore";
import { rewriteMarkdownImageSources } from "@shared/markdown-images";
import { artifactImageUrl } from "@shared/artifact-ipc";
import { ChatImageScope } from "@/components/chat/ChatImage";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatMarkdown from "@/components/chat/ChatMarkdown";
import { IconPlus, IconArchive, IconChevronDown, IconArrowUp, IconBot, IconCheck, IconChevronRight, IconClock, IconListTodo, IconMessageDashed, IconPanel, IconSearch, IconSettings, IconStop, IconX } from "@/components/common/icons";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { activeBotReply, botParticipatesInWork, botMessageStatus, botWorkTimeline, shouldSendBotComposer, workMatchesView, workStatusLabel, workCardExcerpt, type BotWorkspaceView } from "@/lib/botWorkspacePresentation";
import { BotWorkDetails } from "./BotWorkDetails";
import { BotResultReport } from "./BotWorkResult";
import { BotTeamDialog } from "./BotTeamDialog";
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
const views: Array<{ id: BotWorkspaceView; label: string; icon: typeof IconBot }> = [
  { id: "conversation", label: "对话", icon: IconMessageDashed },
  { id: "active", label: "未结束", icon: IconClock },
  { id: "closed", label: "已结束", icon: IconCheck },
];

export default function BotWorkspacePage(props: { onToggleNavigation?: () => void; navigationVisible?: boolean; onCreateBot?: () => void } = {}): React.JSX.Element {
  const setPage = useAppStore(s => s.setPage);
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
  const selectedWorkId = useAppStore(s => s.selectedWorkId);
  const setSelectedWorkId = useAppStore(s => s.setSelectedWorkId);
  const hostStatus = useAppStore(s => s.botHostStatus);
  const workError = useAppStore(s => s.botWorkError);
  const allWorksLoaded = useAppStore(s => s.botWorkCursor?.scope === "all");
  const [includeClosed, setIncludeClosed] = useState(allWorksLoaded);
  const [view, setView] = useState<BotWorkspaceView>("conversation");
  const [query, setQuery] = useState("");
  const compact = useMediaQuery("(max-width: 1180px)");
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(selectedWorkId));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const requestedWork = useRef<string | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const inspectorRef = useRef<HTMLDialogElement>(null);
  const settingsRef = useRef<HTMLDialogElement>(null);
  const newConversationRef = useRef<HTMLDialogElement>(null);
  const followLatest = useRef(true);
  const followReplyTail = useRef(false);
  const previousScrollTop = useRef(0);
  const lastBot = useRef(activeBotId);
  const activeBot = identities.find(bot => bot.botId === activeBotId) ?? null;
  const botWorks = works.filter(work => botParticipatesInWork(work, activeBot?.botId));
  const selected = botWorks.find(work => work.workId === selectedWorkId) ?? null;
  const messages = activeBotId ? histories[activeBotId]?.messages ?? [] : [];
  const lastMessage = messages[messages.length - 1];
  const activeReply = activeBotReply(messages);
  const sending = Boolean(activeBotId && pendingSends[activeBotId]?.sending);
  const attachments = activeBotId ? attachmentDrafts[activeBotId] ?? [] : [];
  const canSend = Boolean(activeBotId && (botDraft.trim() || attachments.length || pendingSends[activeBotId]) && !sending && !attachmentBusy);
  const addAttachments = async (source: File[] | "pick") => {
    const botId = activeBotId;
    if (!botId) return;
    setAttachmentBusy(true); setAttachmentError("");
    try {
      const selected = source === "pick" ? await pickComposerAttachment() : undefined;
      const incoming = source === "pick" ? (selected ? [selected] : []) : await composerFiles(source);
      const state = useAppStore.getState();
      state.setBotAttachments(botId, mergeComposerAttachments(state.botAttachmentDrafts[botId] ?? [], incoming));
    } catch (error) { if (useAppStore.getState().activeBotId === botId) setAttachmentError(error instanceof Error ? error.message : String(error)); }
    finally { setAttachmentBusy(false); }
  };

  useEffect(() => () => { requestedWork.current = null; }, []);
  useEffect(() => { void useAppStore.getState().refreshBotWork(includeClosed); }, [includeClosed]);
  useEffect(() => {
    if (!activeBotId) return;
    const refresh = () => { void useAppStore.getState().refreshBotHistory(activeBotId); void useAppStore.getState().refreshBotWork(includeClosed); };
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [activeBotId, includeClosed]);
  useEffect(() => {
    if (lastBot.current === activeBotId) return;
    lastBot.current = activeBotId; setAttachmentError("");
    requestedWork.current = null; setNavigationNotice("");
    setView("conversation"); setQuery(""); setSettingsOpen(false); setArchiveConfirm(false); setNewConversationOpen(false); setInspectorOpen(false);
    followLatest.current = true; followReplyTail.current = false; previousScrollTop.current = 0;
  }, [activeBotId]);
  useEffect(() => { if (selectedWorkId) setInspectorOpen(true); }, [selectedWorkId]);
  useEffect(() => {
    const dialog = inspectorRef.current;
    if (!dialog) return;
    if (!inspectorOpen || !selected) { if (dialog.open) dialog.close(); return; }
    // The same mounted details tree survives resizing. Only the native dialog mode changes.
    if (dialog.open) dialog.close();
    if (compact) dialog.showModal(); else dialog.show();
    return () => { if (dialog.open) dialog.close(); };
  }, [inspectorOpen, Boolean(selected), compact]);
  useEffect(() => {
    const dialog = settingsRef.current;
    if (settingsOpen) dialog?.showModal(); else if (dialog?.open) dialog.close();
  }, [settingsOpen]);
  useEffect(() => {
    const dialog = newConversationRef.current;
    if (newConversationOpen) dialog?.showModal(); else if (dialog?.open) dialog.close();
  }, [newConversationOpen]);
  useEffect(() => {
    if (view !== "conversation" || !followLatest.current) return;
    const frame = requestAnimationFrame(() => {
      const el = threadRef.current;
      if (!el) return;
      const reply = followReplyTail.current ? null : el.querySelector<HTMLElement>('[data-streaming="true"]');
      const bottom = el.scrollHeight - el.clientHeight;
      // Keep the start of a long answer readable. Once it fills the viewport,
      // pause following rather than dragging the reader past its opening.
      const start = reply ? reply.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16 : bottom;
      el.scrollTop = reply ? Math.min(bottom, Math.max(0, start)) : bottom;
      if (reply && bottom > start + 24) {
        followLatest.current = false;
        setAwayFromBottom(true);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activeBotId, view, messages.length, lastMessage?.text, lastMessage?.status, activeReply?.messageId, activeReply?.text, activeReply?.status]);
  useEffect(() => {
    const thread = threadRef.current;
    const list = thread?.querySelector(".bot-message-list");
    if (!thread || !list || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    // Markdown can grow after the text frame commits (tables, code and fonts).
    // Only explicit tail-following tracks those layout changes; readers stay put.
    const observer = new ResizeObserver(() => {
      if (!followLatest.current || !followReplyTail.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followLatest.current && followReplyTail.current) thread.scrollTop = thread.scrollHeight;
      });
    });
    observer.observe(list);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [activeBotId, view, messages.length]);
  useEffect(() => {
    const body = inspectorRef.current?.querySelector(".bot-inspector-body");
    if (body) body.scrollTop = 0;
  }, [selected?.workId]);


  const openWork = (workId: string) => {
    requestedWork.current = workId;
    setNavigationNotice("");
    if (botWorks.some(work => work.workId === workId)) { setSelectedWorkId(workId); setInspectorOpen(true); return; }
    // A historic message can point to an ended work outside the open-only projection.
    // Resolve it before changing selection, and ignore a late lookup after switching Bot.
    const botId = activeBotId;
    setIncludeClosed(true);
    setNavigationNotice("正在读取关联事项…");
    void useAppStore.getState().refreshBotWork(true).then(() => {
      const state = useAppStore.getState();
      if (requestedWork.current !== workId || state.activeBotId !== botId) return;
      if (state.botWorks.some(work => work.workId === workId && botParticipatesInWork(work, botId))) {
        state.setSelectedWorkId(workId); setInspectorOpen(true); setNavigationNotice("");
      } else setNavigationNotice("暂时无法打开此事项，请在已结束列表中核对或稍后重试。");
    });
  };
  const changeView = (next: BotWorkspaceView) => {
    requestedWork.current = null; setNavigationNotice("");
    setView(next); setQuery("");
    if (next === "closed") setIncludeClosed(true);
  };
  const send = () => {
    if (!canSend) return;
    followLatest.current = true; followReplyTail.current = false; previousScrollTop.current = 0; setAwayFromBottom(false); setView("conversation"); void submitBotDraft();
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
    state.setSelectedWorkId(work.workId); state.setBotDraft(draft);
    setView("conversation"); setInspectorOpen(false);
    requestAnimationFrame(() => { setInspectorOpen(false); composerRef.current?.focus(); });
  };
  const filteredWorks = botWorks.filter(work => workMatchesView(work, view) && work.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return <div className="bot-workspace" onKeyDownCapture={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { setInspectorOpen(false); setSettingsOpen(false); } }}>
    <section className="bot-conversation" aria-label="Bot 对话">
      <header className="bot-workspace-header">
        {props.onToggleNavigation && <button type="button" className="bot-icon-button" aria-label={props.navigationVisible ? "收起导航" : "展开导航"} aria-expanded={props.navigationVisible} onClick={props.onToggleNavigation}><IconPanel size={18} /></button>}
        <span className="bot-avatar bot-header-avatar" aria-hidden="true"><IconBot size={21} /></span>
        <div className="bot-heading"><h1>{activeBot?.displayName ?? "Bot 模式"}</h1><p><span className={`bot-presence ${hostStatus?.online && activeBot?.status === "active" ? "is-online" : ""}`} />{activeBot ? presenceLabel(activeBot, hostStatus) : "你的长期个人助理"}<span className="bot-heading-description"> · 对话有延续，事项有着落</span></p></div>
        <div className="bot-workspace-actions">
          <button type="button" className="bot-quiet-button bot-new-conversation" disabled={!activeBot || messages.length === 0} onClick={() => { setArchiveError(""); setNewConversationOpen(true); }}>新对话</button>
          <details className="bot-header-more" onClick={event => { if ((event.target as HTMLElement).closest("button")) event.currentTarget.open = false; }}><summary aria-label="更多 Bot 操作">更多</summary><div className="bot-header-menu">
          <button type="button" className="bot-quiet-button" onClick={() => { setInspectorOpen(false); setSettingsOpen(false); setTeamOpen(true); }}>组队开工</button>
          {props.onCreateBot && <button type="button" className="bot-quiet-button" onClick={() => { setInspectorOpen(false); setSettingsOpen(false); props.onCreateBot?.(); }}>+ 新建 Bot</button>}
          <button type="button" className="bot-quiet-button bot-return" onClick={() => setPage("chat")}>返回普通模式</button>
          </div></details>
          <button type="button" className="bot-icon-button" aria-label="Bot 设置与对话管理" onClick={() => setSettingsOpen(true)}><IconSettings size={18} /></button>
        </div>
      </header>
      <nav className="bot-view-tabs" aria-label="对话与事项">
        {views.map(item => {
          const count = item.id === "conversation" ? undefined : item.id === "closed" && !allWorksLoaded ? undefined : botWorks.filter(work => workMatchesView(work, item.id)).length;
          return <button type="button" key={item.id} aria-current={view === item.id ? "page" : undefined} onClick={() => changeView(item.id)}><item.icon size={15} /><span>{item.label}</span>{count !== undefined && <span className="bot-tab-count">{count}</span>}</button>;
        })}
      </nav>
      {workError && <p className="bot-alert" role="alert">{workError}</p>}
      {navigationNotice && <p className="bot-navigation-notice" role="status">{navigationNotice}</p>}
      {view === "conversation" ? <>
        <div className="bot-thread" ref={threadRef} role="log" aria-label="对话记录" aria-live="off" onScroll={() => {
          const el = threadRef.current; if (!el) return;
          const movedUp = el.scrollTop < previousScrollTop.current - 1;
          previousScrollTop.current = el.scrollTop;
          followLatest.current = !movedUp && el.scrollHeight - el.scrollTop - el.clientHeight < 72;
          setAwayFromBottom(!followLatest.current);
        }}>
          {messages.length === 0 ? <div className="bot-conversation-empty">
            <span className="bot-welcome-icon" aria-hidden="true"><IconBot size={30} /></span>
            <span className="bot-eyebrow">从一句话开始</span>
            <h2>{activeBot ? "有什么想一起推进的？" : "还没有 Bot"}</h2>
            <p>{activeBot ? "聊想法、交代事项，或继续上次的进展。普通聊天不会自动创建事项。" : "创建一个 Bot，给它名称和职责，就能开始独立的对话。"}</p>
            {!activeBot && props.onCreateBot && <button type="button" className="bot-empty-create" onClick={props.onCreateBot}>创建第一个 Bot</button>}
            {activeBot && <div className="bot-example-grid">{examples.map(example => <button type="button" key={example.title} onClick={() => draftExample(example.text)}><span>{example.title}</span><IconArrowUp size={16} /></button>)}</div>}
          </div> : <div className="bot-message-list">{botWorkTimeline(messages).map(row => row.kind === "message"
            ? <BotMessage key={row.key} message={row.message} botName={activeBot?.displayName ?? "Bot"} works={botWorks} onOpenWork={openWork} onCancel={() => { if (activeBotId) void useAppStore.getState().cancelBotSend(activeBotId, row.message.requestId); }} />
            : <details key={row.key} className="bot-work-progress" aria-label="事项进展记录">
              <summary>{row.workIds.length > 1 ? `${row.workIds.length} 个事项` : botWorks.find(work => work.workId === row.workId)?.title ?? "事项"} · {row.messages.length} 条执行记录（展开查看）</summary>
              {row.messages.map(message => <BotMessage key={message.messageId} message={message} botName={activeBot?.displayName ?? "Bot"} works={botWorks} onOpenWork={openWork} onCancel={() => {}} />)}
            </details>)}</div>}
        </div>
      </> : <section className="bot-work-browser" aria-label={`${views.find(item => item.id === view)?.label}事项`}>
        <header className="bot-list-heading"><div><h2>{view === "active" ? "尚未结束的事项" : "每一件事，都有记录"}</h2><p>{view === "active" ? "执行状态与验收分开显示。已有结果的事项不代表仍在运行。" : "保留已完成、已取消与未完成的结束记录。"}</p></div><label className="bot-work-search"><IconSearch size={15} /><span className="bot-sr-only">搜索事项</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索事项" /></label></header>
        {view === "closed" && !allWorksLoaded ? <p role="status">正在读取已结束事项…</p> : filteredWorks.length ? <div className="bot-work-grid">{filteredWorks.map(work => <WorkCard key={work.workId} work={work} selected={work.workId === selected?.workId} onSelect={() => openWork(work.workId)} />)}</div> : <div className="bot-list-empty"><IconListTodo size={30} /><h3>{query ? "没有找到匹配的事项" : view === "closed" ? "还没有结束的事项" : "没有尚未结束的事项"}</h3><p>{query ? "试试其他关键词。" : "回到对话，说说你想交给我的事。"}</p><button type="button" onClick={() => { setView("conversation"); composerRef.current?.focus(); }}>回到对话</button></div>}
      </section>}
      <form className="bot-composer input-area" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void addAttachments(Array.from(event.dataTransfer.files)); } }} onSubmit={event => { event.preventDefault(); send(); }}>
        {view === "conversation" && awayFromBottom && <button type="button" className="bot-latest-button" onClick={() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; followLatest.current = true; followReplyTail.current = true; setAwayFromBottom(false); }}><IconChevronDown size={14} />回到最新消息</button>}
        {activeBotId && sendErrors[activeBotId] && <p className="bot-send-error" role="alert">{sendErrors[activeBotId]}</p>}
        {selected && <div className="bot-composer-context"><button type="button" onClick={() => setInspectorOpen(true)}><IconListTodo size={14} /><span>当前事项：{selected.title}</span><IconChevronRight size={14} /></button><button type="button" className="bot-icon-button" aria-label="取消关联事项，返回普通对话" onClick={() => { requestedWork.current = null; setNavigationNotice(""); setSelectedWorkId(null); setInspectorOpen(false); }}><IconX size={14} /></button></div>}
        {attachmentError && <p className="bot-send-error" role="alert">{attachmentError}</p>}
        <div className="bot-composer-box input-box">{attachments.length > 0 && <div className="input-attach-chips"><ComposerAttachmentChips attachments={attachments} onRemove={item => { if (activeBotId) useAppStore.getState().setBotAttachments(activeBotId, attachments.filter(value => value.path !== item.path)); }} /></div>}<label htmlFor="bot-draft" className="bot-sr-only">给 Bot 发消息</label><ChatComposer ref={composerRef} aria-label="给 Bot 发消息" id="bot-draft" onPaste={event => { const files = pastedComposerFiles(event.clipboardData); if (files.length) { event.preventDefault(); void addAttachments(files); } }} value={botDraft} maxLength={32000} onChange={event => setBotDraft(event.target.value)} onKeyDown={event => { if (shouldSendBotComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) { event.preventDefault(); send(); } }} placeholder={selected ? "补充要求，或问问这件事的进展…" : "说说你想做什么…"} rows={2} toolbarClassName="bot-composer-toolbar input-toolbar" toolbar={<><button type="button" className="input-tool-btn" aria-label="添加附件" title="添加附件" disabled={!activeBotId || attachmentBusy} onClick={() => void addAttachments("pick")}><IconPlus size={16} /></button><span className="bot-composer-status" role="status">{sending ? "正在发送…" : notice ? "消息已发送" : "Enter 发送 · Shift + Enter 换行"}</span><span className="bot-composer-send-actions">{activeReply && activeBotId && <button type="button" className="bot-stop-button send-btn stop-btn" aria-label="停止当前回复" onClick={() => { void useAppStore.getState().cancelBotSend(activeBotId, activeReply.requestId); }}><IconStop size={15} /></button>}<button type="submit" className="bot-send-button send-btn" disabled={!canSend} aria-label={activeBotId && pendingSends[activeBotId]?.error ? "重试原请求" : "发送消息"}><IconArrowUp size={17} /></button></span></>} /></div>
      </form>
    </section>
    {selected && <dialog ref={inspectorRef} className={`bot-inspector ${compact ? "is-drawer" : view === "conversation" ? "is-overlay" : ""}`} aria-label="事项详情" onCancel={event => { event.preventDefault(); setInspectorOpen(false); }} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right) setInspectorOpen(false); } }}>
      <header className="bot-inspector-header"><span>事项详情</span><button type="button" className="bot-icon-button" aria-label="关闭详情" onClick={() => setInspectorOpen(false)}><IconX size={18} /></button></header>
      <div className="bot-inspector-body"><BotWorkDetails key={selected.workId} work={selected} ownerName={identities.find(bot => bot.botId === selected.ownerBotId)?.displayName ?? selected.ownerBotId} includeClosed={includeClosed} onReplyToBlocker={blocker => replyToBlocker(selected, blocker)} /></div>
    </dialog>}
    <dialog ref={newConversationRef} className="bot-settings-dialog" aria-labelledby="bot-new-conversation-title" onCancel={event => { event.preventDefault(); if (!archiving) setNewConversationOpen(false); }}>
      <header className="bot-inspector-header"><h2 id="bot-new-conversation-title">开始新对话</h2><button type="button" className="bot-icon-button" aria-label="取消新对话" disabled={archiving} onClick={() => setNewConversationOpen(false)}><IconX size={18} /></button></header>
      <div className="bot-settings-body"><p>当前对话将归档，已创建的事项继续保留。新对话从空白上下文开始。</p>{activeReply && <p role="status">请先停止或等待当前回复完成，再开始新对话。</p>}{archiveError && <p role="alert" className="bot-alert">{archiveError}</p>}
        <button type="button" disabled={archiving || Boolean(activeReply)} onClick={() => {
          if (!activeBotId) return;
          const sourceBotId = activeBotId;
          setArchiving(true); setArchiveError("");
          void useAppStore.getState().archiveBotConversation(sourceBotId).then(() => { if (useAppStore.getState().activeBotId !== sourceBotId) return; setNewConversationOpen(false); setView("conversation"); setSelectedWorkId(null); setInspectorOpen(false); requestAnimationFrame(() => composerRef.current?.focus()); }).catch(error => setArchiveError(error instanceof Error ? error.message : "开始新对话失败，请重试。")).finally(() => setArchiving(false));
        }}>{archiving ? "正在归档…" : "归档并开始新对话"}</button><button type="button" disabled={archiving} onClick={() => setNewConversationOpen(false)}>取消</button>
      </div>
    </dialog>
    <BotTeamDialog open={teamOpen} onClose={() => setTeamOpen(false)} />
    <dialog ref={settingsRef} className="bot-settings-dialog" aria-labelledby="bot-settings-title" onCancel={event => { event.preventDefault(); setSettingsOpen(false); setArchiveConfirm(false); }}>
      <header className="bot-inspector-header"><h2 id="bot-settings-title">Bot 设置与对话管理</h2><button type="button" className="bot-icon-button" aria-label="关闭 Bot 设置" onClick={() => { setSettingsOpen(false); setArchiveConfirm(false); }}><IconX size={18} /></button></header>
      <div className="bot-settings-body">{activeBot && <section className="bot-settings-identity" aria-label="Bot 身份与职责"><h3>{activeBot.displayName}</h3><p>{activeBot.responsibilitySummary || "尚未设置具体职责。你可以在对话中说明这次希望它协助的目标。"}</p><p>独立 Bot 身份。当前配置与操作范围以已生效的版本及授权为准。</p></section>}{activeBot && <><BotExecutionSettings key={`settings-${activeBot.botId}-${settingsOpen}`} botId={activeBot.botId} onManageModels={() => { setSettingsOpen(false); setArchiveConfirm(false); }} /><BotWorkspaceAuthorization key={activeBot.botId} bot={activeBot} /><details className="bot-advanced"><summary>专家配置与权限审阅</summary><BotExpertReview botId={activeBot.botId} /></details>
<BotDeletion bot={activeBot} onDeleted={() => setSettingsOpen(false)} /><section className="bot-archive-section">{archiveError && <p role="alert" className="bot-alert">{archiveError}</p>}<h3>归档当前对话</h3><p>收起这段对话，开始新的聊天。事项记录仍会保留。</p>{archiveConfirm ? <div role="group" aria-label="确认归档"><p>确定归档当前对话吗？</p><button type="button" disabled={archiving} onClick={() => { setArchiving(true); setArchiveError(""); void useAppStore.getState().archiveBotConversation(activeBot.botId).then(() => { setArchiveConfirm(false); setSettingsOpen(false); }).catch(error => setArchiveError(error instanceof Error ? error.message : "归档未完成，请稍后重试。")).finally(() => setArchiving(false)); }}>{archiving ? "正在归档…" : "确认归档"}</button><button type="button" disabled={archiving} onClick={() => setArchiveConfirm(false)}>取消</button></div> : <button type="button" onClick={() => setArchiveConfirm(true)}><IconArchive size={15} />归档对话</button>}</section></>}</div>
    </dialog>
  </div>;
}

export function BotMessage({ message, botName, works, onOpenWork, onCancel }: { message: BotMessageDto; botName: string; works: WorkProjectionDto[]; onOpenWork: (id: string) => void; onCancel: () => void }): React.JSX.Element {
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
    {message.role === "user" ? <div className="user-bubble">{Boolean(message.attachments?.length) && <div className="input-attach-chips"><ComposerAttachmentChips attachments={message.attachments ?? []} /></div>}{message.text && <div className="user-bubble-text">{message.text}</div>}</div> : <div className="bot-assistant-content">{message.text ? <>{result ? <BotResultReport message={message} work={works.find(work => work.workId === message.workFeedback?.workId)} renderMarkdown={renderMarkdown} /> : renderMarkdown(message.text)}</> : <p className="bot-reply-placeholder" role={running ? "status" : undefined}>{message.status === "completed" ? "没有文本回复" : botMessageStatus(message)}{running && <span className="bot-typing-dots" aria-hidden="true">···</span>}</p>}</div>}
    {message.workIds.length > 0 && <div className="bot-message-work-links">{message.workIds.map(workId => <button type="button" key={workId} onClick={() => onOpenWork(workId)}><IconListTodo size={14} /><span>{works.find(work => work.workId === workId)?.title ?? "查看关联事项"}</span><IconChevronRight size={14} /></button>)}</div>}
    <div className="bot-message-meta">{(message.text || !running) && <span role={running ? "status" : undefined}>{botMessageStatus(message)}</span>}<time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>{running && <button type="button" onClick={onCancel}><IconStop size={14} />停止回复</button>}</div>
    {message.error && <p className="bot-alert" role="alert">{message.error}</p>}
  </article>;
}

function WorkCard({ work, selected, onSelect }: { work: WorkProjectionDto; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const latest = [...work.deliverables].reverse().find(item => item.status === "accepted" || item.status === "proposed");
  return <button type="button" className="bot-work-card" aria-pressed={selected} onClick={onSelect}>
    <div className="bot-work-card-top"><span className={`bot-status-badge ${work.closureConclusion === "succeeded" ? "success" : ""}`}>{workStatusLabel(work)}</span><span>{work.team ? `${work.team.members.length + 1} 位 Bot 组队` : work.mode === "watch" ? "持续关注" : "单次委托"}</span></div>
    <strong>{work.title}</strong><p className="bot-work-excerpt"><span>{latest ? "成果摘录：" : "下一步："}</span>{workCardExcerpt(latest?.summary ?? work.nextSteps[0] ?? "打开查看目标、进展与成果。", work.title)}</p>
    <div className="bot-work-card-bottom"><span>{work.deliverables.length ? `${work.deliverables.length} 项成果` : "等待成果"} · {new Date(work.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span><span className="bot-work-card-open">查看完整内容<IconChevronRight size={16} /></span></div>
  </button>;
}
