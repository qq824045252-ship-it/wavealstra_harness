import { useBotIncomingMessages } from '@/hooks/useBotIncomingMessages';
import { mergeBotTimeline, groupBotTimeline, unrepresentedIncomingMessages } from '@/lib/botMergedTimeline';
import { BotAvatar } from "../common/BotAvatar";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useAppStore } from '@/store/appStore';
import type {
  BotCollaborationDto, BotCollaborationHistoryPage, BotCollaborationMessageDto, BotCollaborationsPage, BotCollaborationsQuery,
} from '@shared/bot-collaboration';
import { botSendSchema } from '@shared/bot-conversation';
import { IconBot, IconChevronLeft, IconChevronUp, IconMessageDashed, IconRefresh, IconX } from '@/components/common/icons';
import ChatMarkdown from './BotChatMarkdown';
import { ChatImageScope } from '@/components/chat/ChatImage';
import { BotCallThread, collaborationDisplayStatus, collaborationParticipantUnavailable, collaborationElapsed, collaborationStatus, collaborationTotalEnd, collaborationWorkStatus } from './BotCallThread';
import './BotCollaborationView.css';

const PAGE_SIZE = 50;
const draftKey = 'mybuddy.bot-collaboration-drafts';
const draftsSchema = z.record(z.string(), z.object({ draft: z.string(), pending: botSendSchema.optional() }));
type FollowupDraft = z.infer<typeof draftsSchema>[string];

function readDraft(key: string): FollowupDraft {
  try { return draftsSchema.parse(JSON.parse(localStorage.getItem(draftKey) ?? '{}'))[key] ?? { draft: '' }; }
  catch { return { draft: '' }; }
}
function saveDraft(key: string, value: FollowupDraft): void {
  let values: z.infer<typeof draftsSchema> = {};
  try { values = draftsSchema.parse(JSON.parse(localStorage.getItem(draftKey) ?? '{}')); } catch { /* Replace an invalid optional draft cache. */ }
  try {
    localStorage.setItem(draftKey, JSON.stringify({ ...values, [key]: value }));
  } catch { /* The host receipt remains authoritative if local storage is unavailable. */ }
}
function mergeMessages(previous: BotCollaborationMessageDto[], incoming: BotCollaborationMessageDto[]) {
  return [...new Map([...previous, ...incoming].map(item => [item.messageId, item])).values()].sort((a, b) => a.ordinal - b.ordinal);
}
function journalOrdinals(page: BotCollaborationHistoryPage): number[] {
  return [...page.messages.map(item => item.ordinal), ...page.events.map(item => item.ordinal)].sort((a, b) => a - b);
}
function hasJournalGap(page: BotCollaborationHistoryPage): boolean {
  return journalOrdinals(page).some((ordinal, index, all) => index > 0 && ordinal > all[index - 1] + 1);
}
function mergeHistory(previous: BotCollaborationHistoryPage | undefined, incoming: BotCollaborationHistoryPage, older = false): BotCollaborationHistoryPage {
  if (!previous) return incoming;
  const messages = mergeMessages(previous.messages, incoming.messages);
  const previousOrdinals = journalOrdinals(previous), incomingOrdinals = journalOrdinals(incoming);
  const gap = incomingOrdinals.length > 0 && previousOrdinals.length > 0
    && incomingOrdinals[0] > previousOrdinals[previousOrdinals.length - 1] + 1;
  const hasEarlier = previousOrdinals.length > 0 && incomingOrdinals.length > 0 && previousOrdinals[0] < incomingOrdinals[0];
  return {
    ...incoming,
    collaboration: older ? previous.collaboration : incoming.collaboration,
    totalMessages: older ? previous.totalMessages : incoming.totalMessages,
    messages,
    events: [...new Map([...previous.events, ...incoming.events].map(item => [item.eventId, item])).values()].sort((a, b) => a.ordinal - b.ordinal),
    previews: older ? previous.previews : incoming.previews,
    nextCursor: older || gap || !hasEarlier ? incoming.nextCursor : previous.nextCursor,
  };
}
function recordedTime(value: number | null): React.ReactNode {
  if (value === null) return <span className="bot-collaboration-unrecorded">未记录</span>;
  const date = new Date(value);
  return <time dateTime={date.toISOString()} title={date.toISOString()}>{date.toLocaleString()}</time>;
}
function duration(start: number | null, end: number | null): string {
  if (start === null || end === null || end < start) return '未记录';
  const seconds = (end - start) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(1)} 秒`;
}
function messageLabel(message: BotCollaborationMessageDto): string {
  switch (message.kind) {
    case 'request': return '发出请求';
    case 'reply': return '回复';
    case 'progress': return '进展';
    case 'result': return message.workFeedback?.report?.milestone || message.workFeedback?.report?.completion?.outcome === 'partial' ? '阶段成果' : '结果回传';
  }
}

function Followup({ collaboration, botId, onAccepted }: { collaboration: BotCollaborationDto; botId: string; onAccepted: () => void }) {
  const key = `${botId}:${collaboration.collaborationId}`;
  const [value, setValue] = useState(() => readDraft(key));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const flight = useRef(false);
  const update = (next: FollowupDraft) => { setValue(next); saveDraft(key, next); };
  const submit = async () => {
    if (flight.current || collaborationParticipantUnavailable(collaboration) || !collaboration.originAvailable || (!value.pending && !value.draft.trim())) return;
    const request = value.pending ?? {
      botId: collaboration.sourceBotId, conversationId: collaboration.sourceConversationId,
      selectedCollaborationId: collaboration.collaborationId, requestId: crypto.randomUUID(), text: value.draft.trim(),
    };
    if (request.botId !== collaboration.sourceBotId || request.conversationId !== collaboration.sourceConversationId
      || request.selectedCollaborationId !== collaboration.collaborationId) {
      setError('保留请求与当前协作不匹配，未发送任何内容。'); return;
    }
    flight.current = true; setSending(true); setError(''); setNotice('');
    update({ draft: value.draft, pending: request });
    try {
      const api = window.api?.botWork;
      if (!api) throw new Error('主机离线，发送结果未确认，请按原请求重试。');
      const receipt = await api.sendMessage(request);
      if (receipt.botId !== request.botId || receipt.requestId !== request.requestId || receipt.conversationId !== request.conversationId)
        throw new Error('发送回执身份不匹配，发送结果待核实。');
      update({ draft: '' }); setNotice('消息已接收。后续回复会更新到这段协作。'); onAccepted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '发送结果未确认，请按原请求重试。'); }
    finally { flight.current = false; setSending(false); }
  };
  if (collaborationParticipantUnavailable(collaboration)) return <p className="bot-collaboration-readonly" role="status">参与协作的 Bot 已删除。历史消息和成果仍可查看，不能向已删除的 Bot 发送跟进。</p>;
  if (botId !== collaboration.sourceBotId) return <p className="bot-collaboration-readonly">这是 {collaboration.sourceDisplayName} 发起的协作。可在来源 Bot 的协作记录中继续。</p>;
  if (!collaboration.originAvailable) return <p className="bot-collaboration-readonly" role="status">原始对话已不可用。保留的记录不会转发到其他对话。</p>;
  return <form className="bot-collaboration-followup" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label htmlFor={`collaboration-followup-${collaboration.collaborationId}`}>继续与 {collaboration.targetDisplayName} 协作</label>
    <textarea id={`collaboration-followup-${collaboration.collaborationId}`} value={value.draft} rows={3} maxLength={32000}
      disabled={sending || Boolean(value.pending)} onChange={event => { update({ draft: event.target.value }); setNotice(''); }}
      placeholder="补充要求，或询问这件事的进展…" />
    {value.pending && !sending && <p role="status">上次发送结果待确认。重试会核对同一个请求。</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button type="submit" disabled={sending || (!value.pending && !value.draft.trim())}>{sending ? '正在发送…' : value.pending ? '按原请求重试' : '发送跟进消息'}</button>
  </form>;
}

function CollaborationHistory({ botId, collaborationId, onOpenWork }: { botId: string; collaborationId: string; onOpenWork?: (workId: string) => void }) {
  const [page, setPage] = useState<BotCollaborationHistoryPage>();
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [retry, setRetry] = useState(0);
  const live = useRef(true);
  const olderFlight = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  useEffect(() => {
    let active = true, inFlight = false;
    live.current = true;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const api = window.api?.botWork;
        if (!api?.collaborationHistory) throw new Error('协作记录接口不可用，请更新并重启应用。');
        const result = await api.collaborationHistory({ botId, collaborationId, limit: PAGE_SIZE });
        if (result.collaboration.collaborationId !== collaborationId || ![result.collaboration.sourceBotId, result.collaboration.targetBotId].includes(botId))
          throw new Error('协作记录身份不匹配。');
        if (active) { setPage(previous => mergeHistory(previous, result)); setError(''); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : '暂时无法读取协作记录。'); }
      finally { inFlight = false; }
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 2500);
    return () => { active = false; live.current = false; clearInterval(timer); };
  }, [botId, collaborationId, retry]);
  const older = async () => {
    if (!page?.nextCursor || olderFlight.current) return;
    olderFlight.current = true; setLoadingOlder(true);
    const element = body.current;
    const first = element && [...element.querySelectorAll<HTMLElement>('[data-collaboration-message-id]')].find(item => item.getBoundingClientRect().bottom > element.getBoundingClientRect().top);
    anchor.current = first && element ? { id: first.dataset.collaborationMessageId ?? '', offset: first.getBoundingClientRect().top - element.getBoundingClientRect().top } : null;
    try {
      const result = await window.api!.botWork.collaborationHistory({ botId, collaborationId, cursor: page.nextCursor, limit: PAGE_SIZE });
      if (result.collaboration.collaborationId !== collaborationId) throw new Error('协作记录身份不匹配。');
      if (live.current) { setPage(previous => mergeHistory(previous, result, true)); setError(''); }
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : '更早记录加载失败。'); }
    finally { olderFlight.current = false; if (live.current) setLoadingOlder(false); }
  };
  useLayoutEffect(() => {
    const element = body.current, saved = anchor.current;
    if (!element || !saved) return;
    const row = [...element.querySelectorAll<HTMLElement>('[data-collaboration-message-id]')].find(item => item.dataset.collaborationMessageId === saved.id);
    if (row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset;
    anchor.current = null;
  }, [page?.messages]);
  const relation = page?.collaboration;
  const executionStart = relation?.work ? relation.work.startedAt : relation?.times.startedAt ?? null;
  const recordedExecutionEnd = relation?.work ? relation.work.endedAt : relation?.times.endedAt ?? null;
  const participantsUnavailable = relation ? collaborationParticipantUnavailable(relation) : false;
  const executionEnd = recordedExecutionEnd ?? (participantsUnavailable ? null : relation?.work ? relation.work.executionStatus === 'running' ? Date.now() : null
    : relation?.status === 'started' ? Date.now() : null);
  return <div className="bot-collaboration-body" ref={body} tabIndex={-1}>
    {error && <p role="alert" className="bot-alert">{error} <button type="button" onClick={refresh}>重试读取</button></p>}
    {!page && !error && <p role="status">正在读取协作记录…</p>}
    {page && relation && <>
      <header className="bot-collaboration-participants"><BotAvatar botId={relation.sourceBotId} name={relation.sourceDisplayName} /><BotAvatar botId={relation.targetBotId} name={relation.targetDisplayName} /><div><h2>{relation.sourceDisplayName} 与 {relation.targetDisplayName}</h2><p>{page.totalMessages} 条消息 · {collaborationDisplayStatus(relation)}</p></div></header>
      <dl className="bot-collaboration-times" aria-label="协作回执时间">
        <div><dt>发送</dt><dd>{recordedTime(relation.times.sentAt)}</dd></div>
        <div><dt>送达</dt><dd>{recordedTime(relation.times.deliveredAt)}</dd></div>
        <div><dt>接收</dt><dd>{recordedTime(relation.times.acceptedAt)}</dd></div>
        <div><dt>本次开始执行</dt><dd>{recordedTime(executionStart)}</dd></div>
        <div><dt>本次执行结束</dt><dd>{recordedTime(recordedExecutionEnd)}</dd></div>
        <div><dt>开始回传</dt><dd>{recordedTime(relation.times.returningAt)}</dd></div>
        <div><dt>回传完成</dt><dd>{recordedTime(relation.times.returnedAt)}</dd></div>
      </dl>
      <p className="bot-collaboration-durations" aria-label="协作耗时"><span>首次排队 {duration(relation.times.acceptedAt, relation.times.startedAt)}</span><span>本次执行 {duration(executionStart, executionEnd)}</span><span>总耗时 {duration(relation.times.sentAt ?? relation.times.acceptedAt, collaborationTotalEnd(relation, Date.now()))}</span></p>
      {relation.workId && <div className="bot-collaboration-work"><strong>{relation.work?.title ?? `由 ${relation.targetDisplayName} 负责的个人事项`}</strong>{onOpenWork && <button type="button" onClick={() => { if (relation.workId) onOpenWork(relation.workId); }}>查看事项</button>}
        {relation.work && <p>{collaborationWorkStatus(relation.work)} · 负责人 {relation.targetDisplayName}{relation.work.progressSummary && ` · ${relation.work.progressSummary}`}</p>}
        <p>回传完成表示本次消息已返回。事项是否完成以事项记录为准。</p></div>}
      <details className="bot-collaboration-events"><summary>送达与执行记录 · {page.events.length} 条已加载记录</summary><ol>{page.events.map(event => <li key={event.eventId}><span>{collaborationStatus(event.kind)}</span> {recordedTime(event.createdAt)}{event.detail && <p>{event.detail}</p>}</li>)}</ol></details>
      <div className="bot-collaboration-paging"><button type="button" onClick={() => void older()} disabled={!page.nextCursor || loadingOlder}>{loadingOlder ? '正在加载更早消息…' : page.nextCursor ? '加载更早消息' : '已到最早消息'}</button><span>已加载 {page.messages.length} / {page.totalMessages} 条消息</span></div>
      {hasJournalGap(page) && <p role="status">部分记录尚未加载，请加载更早消息补齐。</p>}
      <ChatImageScope taskId={null} artifacts={[]} sources={{}}><ol className="bot-collaboration-messages" aria-label="双方协作消息">
        {page.messages.map(message => <li key={message.messageId} data-collaboration-message-id={message.messageId} data-message-kind={message.kind}>
          <header><BotAvatar botId={message.senderBotId} name={message.senderDisplayName} /><strong>{message.senderDisplayName}</strong><span>{messageLabel(message)}</span>{recordedTime(message.createdAt)}</header>
          <ChatMarkdown resolveTaskFiles={false} text={message.text} streaming={false} />
          {message.workFeedback?.report?.completion?.outcome === 'partial' && <p className="bot-collaboration-partial">这是阶段成果，事项仍需继续。</p>}
        </li>)}
      </ol>
      {page.previews.map(preview => <section className="bot-collaboration-preview" key={preview.exchangeId} aria-label={participantsUnavailable ? "历史未完成片段" : "正在生成的回复"}><header><BotAvatar botId={preview.senderBotId} name={preview.senderDisplayName} /><strong>{preview.senderDisplayName}</strong><span>{participantsUnavailable ? "历史未完成片段，未计为消息" : "正在回复，尚未计为消息"}</span></header><ChatMarkdown resolveTaskFiles={false} text={preview.text} streaming={!participantsUnavailable} /></section>)}
      </ChatImageScope>
      <Followup key={`${botId}:${collaborationId}`} collaboration={relation} botId={botId} onAccepted={refresh} />
    </>}
  </div>;
}

function useCollaborations(botId: string, direction: NonNullable<BotCollaborationsQuery['direction']> = 'all', limit = PAGE_SIZE, participants: NonNullable<BotCollaborationsQuery['participants']> = 'current') {
  const membership = useAppStore(state => state.botIdentities.map(bot => bot.botId).sort().join('\n'));
  const [page, setPage] = useState<BotCollaborationsPage>();
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const moreFlight = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setPage(undefined); setLoadingMore(false);
    let inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const api = window.api?.botWork;
        if (!api?.collaborations) throw new Error('协作记录接口不可用，请更新并重启应用。');
        const result = await api.collaborations({ botId, direction, limit, participants });
        if (generation.current === current) {
          setPage(previous => previous && previous.total === result.total && previous.items.length > limit ? { ...result, nextCursor: previous.nextCursor, items: [...new Map([...previous.items, ...result.items].map(item => [item.collaborationId, item])).values()].sort((a, b) => b.createdAt - a.createdAt || b.collaborationId.localeCompare(a.collaborationId)) } : result);
          setError('');
        }
      } catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : '协作列表暂时无法读取。'); }
      finally { inFlight = false; }
    };
    void read();
    const refreshVisible = () => { if (!document.hidden) void read(); };
    const timer = setInterval(refreshVisible, direction === 'incoming' ? 2000 : 5000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { generation.current++; clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [botId, direction, limit, retry, membership, participants]);
  const more = async () => {
    if (!page?.nextCursor || moreFlight.current) return;
    const current = generation.current;
    moreFlight.current = true; setLoadingMore(true);
    try {
      const result = await window.api!.botWork.collaborations({ botId, direction, cursor: page.nextCursor, limit, participants });
      if (generation.current === current) setPage(previous => ({ ...result, items: [...new Map([...(previous?.items ?? []), ...result.items].map(item => [item.collaborationId, item])).values()] }));
    } catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : '更早协作加载失败。'); }
    finally { moreFlight.current = false; if (generation.current === current) setLoadingMore(false); }
  };
  return { page, error, loadingMore, more, retry: () => setRetry(value => value + 1) };
}

export function BotIncomingCollaborations({ botId, onOpen, empty, entries = [], onBeforeOlder, membershipKey = '', representedReplies = [] }: {
 botId?:string; representedReplies?:readonly {collaborationId:string;exchangeId:string}[]; membershipKey?:string; entries?:{key:string;createdAt:number;ordinal:number;value:React.ReactNode;foldKey?:string}[]; onBeforeOlder?:()=>void;onOpen:(id:string)=>void;empty?:React.ReactNode;
}) {
 const {items,before,error,loading,more,retry,retrySummary}=useBotIncomingMessages(botId,membershipKey);
 const personalIds=new Set(entries.map(entry=>entry.key));
 const visibleItems=unrepresentedIncomingMessages(items,personalIds,representedReplies);
 const byId=new Map(visibleItems.map(item=>[item.message.messageId,item]));
 const rows=mergeBotTimeline(entries,visibleItems.map(item=>({collaborationId:item.message.messageId,createdAt:item.message.createdAt})));
 return <section className="bot-merged-timeline" aria-label="对话与协作时间线">
  {error && <p className="bot-alert" role="alert">{error}<button type="button" className="bot-icon-button" title="重试读取" aria-label="重试读取" onClick={()=>void retry()}><IconRefresh size={18}/></button></p>}
  {before && <button type="button" className="bot-icon-button" title="加载更早协作消息" aria-label="加载更早协作消息" disabled={loading} onClick={()=>{onBeforeOlder?.();void more();}}><IconChevronUp size={18}/></button>}
  <div className="bot-message-list">{rows.length===0 ? empty : groupBotTimeline(rows).map(group=>{
   const row=group[0];
   if(row.kind==='personal' && row.foldKey)return <details key={row.key} className="bot-work-progress"><summary>{group.length} 条执行记录</summary>{group.map(item=>item.kind==='personal'?<div key={item.key}>{item.value}</div>:null)}</details>;
   if(row.kind==='personal')return <div key={row.key}>{row.value}</div>;
   const {message,collaboration,summary}=byId.get(row.collaborationId)!;
   return <article key={row.key} className="bot-message msg-row assistant" data-message-id={row.key} data-incoming-collaboration={collaboration.collaborationId}>
    <div className="bot-message-author"><BotAvatar botId={message.senderBotId} name={message.senderDisplayName}/><strong>{message.senderDisplayName}</strong>{recordedTime(message.createdAt)}</div>
    <div className="bot-assistant-content bot-incoming-reply">{summary?.status==='completed' && summary.text.trim() ? <><small>{summary.senderDisplayName} 整理</small><ChatMarkdown text={summary.text} streaming={false} resolveTaskFiles={false}/></> : message.workFeedback?.report?.summary ? <ChatMarkdown text={message.workFeedback.report.summary} streaming={false} resolveTaskFiles={false}/> : message.kind!=='request' ? <p role="status">{summary?.status==='running'||summary?.status==='queued' ? '正在逐条整理…' : summary && ['failed','cancelled','unknown'].includes(summary.status) ? '整理未完成，原文已保留。' : '尚无前台整理结果，原文已保留。'}</p> : null}{summary?.generated && summary.status==='failed' && <button type="button" className="bot-icon-button" title={summary.error ? `重试整理：${summary.error}` : '重试整理'} aria-label="重试整理" disabled={loading} onClick={()=>void retrySummary(message.messageId)}><IconRefresh size={18}/></button>}<details><summary><span>原文摘录 · </span>{Array.from(message.text.trim()).slice(0,160).join('')}{Array.from(message.text.trim()).length>160?'…':''}</summary><ChatMarkdown text={message.text} streaming={false} resolveTaskFiles={false}/></details></div>
    <button type="button" className="bot-icon-button" title="查看协作记录" aria-label="查看协作记录" onClick={()=>onOpen(collaboration.collaborationId)}><IconMessageDashed size={18}/></button>
   </article>;
  })}</div>
 </section>;
}

function CollaborationList({ botId, onOpen }: { botId: string; onOpen: (id: string) => void }) {
  const [participants, setParticipants] = useState<'current' | 'deleted'>('current');
  const { page, error, loadingMore, more, retry } = useCollaborations(botId, 'all', PAGE_SIZE, participants);
  return <div className="bot-collaboration-body" tabIndex={-1}>
    <h2>{participants === 'current' ? '协作记录' : '已删除 Bot 的协作记录'}</h2>
    <div role="group" aria-label="协作记录范围">
      <button type="button" aria-pressed={participants === 'current'} onClick={() => setParticipants('current')}>当前 Bot</button>
      <button type="button" aria-pressed={participants === 'deleted'} onClick={() => setParticipants('deleted')}>已删除 Bot 的记录</button>
    </div>
    <p className="bot-collaboration-description">{participants === 'current' ? '仅显示仍存在的 Bot 之间的协作。' : '仅供查看已删除 Bot 的历史消息和成果，不能继续跟进。'}</p>
    {error && <p role="alert" className="bot-alert">{error} <button type="button" onClick={retry}>重试读取</button></p>}
    {!page && !error && <p role="status">正在读取协作列表…</p>}
    {page && <><p>{page.total} 段协作</p>{page.items.length === 0 && <p>{participants === 'current' ? '没有当前 Bot 的协作记录。' : '没有已删除 Bot 的协作记录。'}</p>}
      <ul className="bot-collaboration-list">{page.items.map(item => <li key={item.collaborationId}><button type="button" onClick={() => onOpen(item.collaborationId)} data-collaboration-id={item.collaborationId}>
        <span className="bot-collaboration-list-title"><BotAvatar botId={item.sourceBotId === botId ? item.targetBotId : item.sourceBotId} name={item.sourceBotId === botId ? item.targetDisplayName : item.sourceDisplayName} />{item.sourceBotId === botId ? `发给 ${item.targetDisplayName}` : `来自 ${item.sourceDisplayName}`}</span>{item.work?.title.trim() && <span className="bot-collaboration-list-work">{`「${item.work.title.trim()}」`}</span>}<span>{item.messageCount} 条消息 · {collaborationDisplayStatus(item)}</span><span>{recordedTime(item.updatedAt)}{item.workId && ' · 已关联个人事项'}</span>
      </button></li>)}</ul>
      {page.nextCursor && <button type="button" className="bot-collaboration-more" onClick={() => void more()} disabled={loadingMore}>{loadingMore ? '正在加载…' : '加载更多协作'}</button>}
    </>}
  </div>;
}

export function BotCollaborationView({ botId, botName, initialCollaborationId, onBack, onOpenWork }: {
  botId: string; botName: string; initialCollaborationId?: string; onBack: () => void; onOpenWork?: (workId: string) => void;
}) {
  const [selected, setSelected] = useState(initialCollaborationId);
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { back.current?.focus({ preventScroll: true }); }, [selected]);
  return <section className="bot-collaboration-view" aria-label="Bot 协作记录" onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onBack(); }
  }}>
    <header className="bot-collaboration-heading"><button type="button" ref={back} onClick={onBack} aria-label={`返回${botName}的对话`}><IconChevronLeft size={18} /><span>{botName}</span></button><h1>{selected ? '双方协作记录' : '协作记录'}</h1>
      {selected && <button type="button" className="bot-collaboration-all" onClick={() => setSelected(undefined)}>全部协作</button>}
      <button type="button" className="bot-icon-button" onClick={onBack} aria-label="关闭协作记录"><IconX size={18} /></button>
    </header>
    {selected ? <CollaborationHistory key={`${botId}:${selected}`} botId={botId} collaborationId={selected} onOpenWork={onOpenWork} /> : <CollaborationList key={botId} botId={botId} onOpen={setSelected} />}
  </section>;
}
