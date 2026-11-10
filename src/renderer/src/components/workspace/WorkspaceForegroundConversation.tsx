import { useEffect, useState } from 'react';
import type { BotWorkspaceRequestDto } from '@shared/bot-workspace-navigation';
import type { BotMessageDto } from '@shared/bot-conversation';
import { BotMessage } from '@/components/pages/BotWorkspacePage';
import { BotWorkDetails } from '@/components/pages/BotWorkDetails';
import type { WorkProjectionDto } from '@shared/bot-work';
import './WorkspaceForeground.css';

/** The original foreground receipt remains authoritative, including archived conversations. */
export function WorkspaceForegroundConversation({ request, conversationTitle, spaceName, onBack }: {
  request: BotWorkspaceRequestDto; conversationTitle?: string; spaceName: string; onBack: () => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<BotMessageDto[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [work, setWork] = useState<WorkProjectionDto>();
  useEffect(() => {
    let live = true;
    setMessages([]); setLoading(true); setError(''); setWork(undefined);
    const load = async () => {
      try {
        const api = window.api?.botWork; if (!api) throw new Error('主机离线，无法读取原始对话');
        let before: number | undefined;
        const all = new Map<string, BotMessageDto>();
        do {
          const history = await api.history({ botId: request.botId, teamId: request.teamId, conversationId: request.conversationId, before });
          if (!live) return;
          if (history.conversationId !== request.conversationId) throw new Error('原始对话身份不匹配，未显示其他会话');
          history.messages.filter(message => message.requestId === request.requestId).forEach(message => all.set(message.messageId, message));
          if ([...all.values()].some(message => message.role === 'user') && [...all.values()].some(message => message.role === 'assistant')) break;
          if (history.before === before) break;
          before = history.before;
        } while (before);
        if (live) { setMessages(current => { for (const message of current) { const loaded = all.get(message.messageId); if (!loaded || (message.messageRevision ?? 0) > (loaded.messageRevision ?? 0)) all.set(message.messageId, message); } return [...all.values()].sort((a,b) => a.ordinal-b.ordinal); }); setError(''); }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : '读取失败'); }
      finally { if (live) setLoading(false); }
    };
    void load();
    const unsubscribe = window.api?.botWork.onMessageChanged?.(event => {
      if (!live || event.conversationId !== request.conversationId || event.message.requestId !== request.requestId) return;
      setMessages(current => {
        const old = current.find(message => message.messageId === event.message.messageId);
        if (old && (old.messageRevision ?? 0) > (event.message.messageRevision ?? 0)) return current;
        return [...current.filter(message => message.messageId !== event.message.messageId), event.message].sort((a,b) => a.ordinal-b.ordinal);
      });
    });
    return () => { live = false; unsubscribe?.(); };
  }, [request.botId, request.teamId, request.conversationId, request.requestId]);
  return <section className="workspace-foreground-view" aria-label="前台任务对话">
    <header className="workspace-foreground-heading"><button className="btn btn--ghost" type="button" onClick={work ? () => setWork(undefined) : onBack}>← {work ? '返回对话' : spaceName}</button><span className="workspace-origin-conversation" title={request.conversationId}>{conversationTitle ?? '原对话'}</span><h2 title={request.title}>{work?.title ?? request.title}</h2></header>
    <div className="workspace-foreground-messages">
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在读取原始对话…</p>}
      {work ? <BotWorkDetails work={work} ownerName={spaceName} includeClosed /> : messages.map(message => <BotMessage key={message.messageId} message={message} botName={spaceName} works={[]} onOpenWork={id => {
        void window.api?.botWork.getWork(id).then(result => { if (result) setWork(result); else setError('找不到关联事项'); }).catch(cause => setError(String(cause)));
      }} onCancel={() => { void window.api?.botWork.cancelSend(request.botId, request.requestId).catch(cause => setError(String(cause))); }} />)}
      {!loading && !error && messages.length === 0 && <p>没有找到此任务的原始消息。请返回工作空间刷新。</p>}
    </div>
  </section>;
}
