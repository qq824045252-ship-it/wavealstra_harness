import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspaceRequestSelection } from '@/lib/workspace-request-selection';
import type { BotMessageDto } from '@shared/bot-conversation';
import { BotMessage } from '@/components/pages/BotMessage';
import { WorkFiles, generatedWorkFiles } from '@/components/pages/BotWorkResult';
import ChatMarkdown from '@/components/pages/BotChatMarkdown';
import { WorkExecutionMetrics } from '@/components/pages/WorkExecutionMetrics';
import type { WorkProjectionDto } from '@shared/bot-work';
import './WorkspaceForeground.css';

/** The original foreground receipt remains authoritative, including archived conversations. */
export function WorkspaceForegroundConversation({ request, conversationTitle, spaceName, onBack }: {
  request: WorkspaceRequestSelection; conversationTitle?: string; spaceName: string; onBack: () => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<BotMessageDto[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [work, setWork] = useState<WorkProjectionDto>();
  const focus = useRef<HTMLDivElement>(null);
  const workTarget = request.focusWork;
  const comment = workTarget?.commentId ? work?.phase3?.collaborationMessages.find(item => item.messageId === workTarget.commentId) : undefined;
  useEffect(() => {
    let live = true;
    setMessages([]); setLoading(true); setError(''); setWork(undefined);
    const load = async () => {
      try {
        const api = window.api?.botWork; if (!api) throw new Error('主机离线，无法读取原始对话');
        if (workTarget) {
          const result = await api.getWork(workTarget.workId);
          if (!live) return;
          if (!result || result.archive?.deletedAt !== undefined) throw new Error('通知对应的事项已不可用');
          setWork(result);
        }
        let before: number | undefined;
        const all = new Map<string, BotMessageDto>();
        do {
          const history = await api.history({ botId: request.botId, teamId: request.teamId, conversationId: request.conversationId, before });
          if (!live) return;
          if (history.conversationId !== request.conversationId) throw new Error('原始对话身份不匹配，未显示其他会话');
          history.messages.filter(message => message.requestId === request.requestId).forEach(message => all.set(message.messageId, message));
          if (request.focusMessageId ? all.has(request.focusMessageId) :
            [...all.values()].some(message => message.role === 'user') && [...all.values()].some(message => message.role === 'assistant')) break;
          if (history.before === before) break;
          before = history.before;
        } while (before);
        if (live) { setMessages(current => { for (const message of current) { const loaded = all.get(message.messageId); if (!loaded || (message.messageRevision ?? 0) > (loaded.messageRevision ?? 0)) all.set(message.messageId, message); } return [...all.values()].sort((a,b) => a.ordinal-b.ordinal); }); setError(''); }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : '读取失败'); }
      finally { if (live) setLoading(false); }
    };
    void load();
    return () => { live = false; };
  }, [request.botId, request.teamId, request.conversationId, request.requestId, request.focusMessageId, workTarget]);
  useLayoutEffect(() => {
    const element = focus.current;
    if (!element || loading) return;
    element.scrollIntoView({ block: 'nearest' });
    element.focus({ preventScroll: true });
  }, [loading, request.focusMessageId, workTarget]);
  return <section className="workspace-foreground-view" aria-label="前台任务对话">
    <header className="workspace-foreground-heading"><button className="btn btn--ghost" type="button" onClick={work ? () => setWork(undefined) : onBack}>← {work ? '返回对话' : spaceName}</button><span className="workspace-origin-conversation" title={request.conversationId}>{conversationTitle ?? '原对话'}</span><h2 title={request.title}>{work?.title ?? request.title}</h2></header>
    <div className="workspace-foreground-messages">
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在读取原始对话…</p>}
      {work ? <section aria-label="历史事项"><h3>{work.title}</h3>
        {workTarget?.commentId && <div ref={focus} tabIndex={-1}>
          {comment ? <ChatMarkdown text={comment.body} streaming={false} resolveTaskFiles={false} /> : <p>通知指定的留言已不可用。</p>}
        </div>}
        <div ref={workTarget?.bindingId && !workTarget.commentId ? focus : undefined} tabIndex={workTarget?.bindingId ? -1 : undefined}>
          <WorkExecutionMetrics work={work} focusBindingId={workTarget?.bindingId} />
        </div>
        <ChatMarkdown text={work.goalDescription ?? work.title} streaming={false} resolveTaskFiles={false} /><WorkFiles files={generatedWorkFiles(work)} /></section> : messages.map(message =>
        <div key={message.messageId} ref={message.messageId === request.focusMessageId ? focus : undefined}
          tabIndex={message.messageId === request.focusMessageId ? -1 : undefined}>
        <BotMessage message={message} workLinkSource={messages.find(item => item.role === 'user' && item.requestId === message.requestId)} botName={spaceName} works={[]} onOpenWork={id => {
        void window.api?.botWork.getWork(id).then(result => { if (result) setWork(result); else setError('找不到关联事项'); }).catch(cause => setError(String(cause)));
      }} onCancel={() => {}} readOnly /></div>)}
      {!loading && !error && messages.length === 0 && <p>没有找到此任务的原始消息。请返回工作空间刷新。</p>}
    </div>
  </section>;
}
