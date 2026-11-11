import type { BotCallDto } from '@shared/bot-conversation';
import { IconBot } from '@/components/common/icons';
import './BotCallThread.css';

function callStatus(call: BotCallDto): string {
  const target = `@${call.targetDisplayName}`;
  switch (call.status) {
    case 'queued': return `等待联系 ${target}`;
    case 'running': return `正在联系 ${target}`;
    case 'completed': return call.replyText?.trim() ? `已收到 ${target} 的回复` : `${target} 已结束，未返回文本回复`;
    case 'failed': return `联系 ${target} 失败：${call.error?.trim() || '主机未提供失败原因'}`;
    case 'cancelled': return `已取消联系 ${target}${call.error?.trim() ? `：${call.error}` : ''}`;
    case 'unknown': return `与 ${target} 的通信状态待核实${call.error?.trim() ? `：${call.error}` : ''}`;
  }
}

/** Only host-persisted exchanges belong here, never mentions parsed from model prose. */
export function BotCallThread({ calls }: { calls?: BotCallDto[] }): React.JSX.Element | null {
  if (!calls?.length) return null;
  const targets = new Map(calls.map(call => [call.targetBotId, call.targetDisplayName]));
  const count = calls.reduce((total, call) => total + Number(Boolean(call.requestText.trim())) + Number(Boolean(call.replyText?.trim())), 0);
  const participants = targets.size === 1 ? [...targets.values()][0] : `${targets.size} 个 Bot`;
  const pending = calls.filter(call => call.status !== 'completed');
  return <details className="bot-call-thread" aria-label="Bot 间通信记录">
    <summary>
      <span className="bot-call-summary">{count} 条消息，与 {participants}</span>
      {pending.length > 0 && <span className="bot-call-summary-status" role="status">{pending.map(call => <span key={call.callId} data-call-status={call.status}>{callStatus(call)}</span>)}</span>}
    </summary>
    <ol className="bot-call-exchanges">
      {calls.map(call => <li key={call.callId} className="bot-call-exchange" data-call-id={call.callId} data-call-status={call.status}>
        {call.requestText.trim() && <div className="bot-call-request">
          <div className="bot-call-author"><span className="bot-avatar" aria-hidden="true"><IconBot size={14} /></span><strong>{call.sourceDisplayName}</strong><span>→ @{call.targetDisplayName}</span></div>
          <p className="bot-call-text">{call.requestText}</p>
        </div>}
        {call.replyText?.trim() && <div className="bot-call-reply">
          <div className="bot-call-author"><span className="bot-avatar" aria-hidden="true"><IconBot size={14} /></span><strong>{call.targetDisplayName}</strong><span>回复 {call.sourceDisplayName}</span></div>
          <p className="bot-call-text">{call.replyText}</p>
        </div>}
        <p className="bot-call-state">{callStatus(call)}</p>
      </li>)}
    </ol>
  </details>;
}
