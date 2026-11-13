import type { BotCallDto } from '@shared/bot-conversation';
import type { BotCollaborationDto, BotCollaborationStatus } from '@shared/bot-collaboration';
import { useEffect, useState } from 'react';
import { BotAvatar } from '@/components/common/BotAvatar';
import { IconChevronRight } from '@/components/common/icons';
import './BotCallThread.css';
import './BotCollaborationView.css';

export function collaborationStatus(status: BotCollaborationStatus): string {
  switch (status) {
    case 'sent': return '发送中';
    case 'delivered': return '已送达';
    case 'accepted': return '已接单';
    case 'started': return '进行中';
    case 'ended': return '本次执行已结束';
    case 'returning': return '回传中';
    case 'returned': return '已返回';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
    case 'unknown': return '状态待核实';
  }
}
function collaborationOngoing(item: BotCollaborationDto): boolean {
  return item.work ? item.work.lifecycle !== 'closed' : !['returned', 'failed', 'cancelled', 'unknown'].includes(item.status);
}
export function collaborationTotalEnd(item: BotCollaborationDto, now: number): number | null {
  if (collaborationOngoing(item)) return now;
  if (item.work?.lifecycle === 'closed') {
    if (item.work.closedAt == null || item.times.returnedAt === null) return null;
    return Math.max(item.work.closedAt, item.times.returnedAt);
  }
  return item.status === 'returned' ? item.times.returnedAt : item.times.endedAt;
}
export function collaborationElapsed(item: BotCollaborationDto, now: number): string {
  const start = item.times.sentAt ?? item.times.acceptedAt;
  const end = collaborationTotalEnd(item, now);
  if (start === null || end === null || end < start) return '未记录';
  const seconds = (end - start) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(0)} 秒`;
}
export function collaborationWorkStatus(work: NonNullable<BotCollaborationDto['work']>): string {
  switch (work.lifecycle) {
    case 'active': {
      switch (work.executionStatus) {
        case 'pending': return '事项等待执行';
        case 'submitted': return '事项已提交，等待执行';
        case 'running': return '事项进行中';
        case 'completed': return '本次执行已结束，事项未结束';
        case 'failed': return '本次执行失败，事项未结束';
        case 'unknown': return '执行状态待核实，事项未结束';
        case 'stopped': return '本次执行已停止，事项未结束';
        case 'invalidated': return '本次执行已失效，事项未结束';
        case undefined: return '事项已受理';
      }
      const unexpected: never = work.executionStatus;
      return unexpected;
    }
    case 'paused': return '事项已暂停';
    case 'closing': return '事项正在收尾';
    case 'closed': return work.closureConclusion === 'succeeded' ? '事项已完成' : work.closureConclusion === 'cancelled' ? '事项已取消' : work.closureConclusion === 'ended_unsuccessfully' ? '事项未成功结束' : '事项已结束';
  }
}

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
export function BotCallThread({ calls, collaborations, onOpenCollaboration, renderReply, viewerBotId }: {
  calls?: BotCallDto[];
  collaborations?: BotCollaborationDto[];
  onOpenCollaboration?: (collaborationId: string) => void;
  renderReply?: (text: string, streaming: boolean) => React.ReactNode;
  viewerBotId?: string;
}): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now);
  const ongoing = Boolean(collaborations?.some(collaborationOngoing));
  useEffect(() => {
    if (!ongoing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ongoing]);
  if (collaborations?.length) {
    const unique = [...new Map(collaborations.map(item => [item.collaborationId, item])).values()];
    const legacy = calls?.filter(call => !('collaborationId' in call) || !unique.some(item => item.collaborationId === call.collaborationId));
    return <>
      <div className="bot-collaboration-summaries" aria-label="Bot 间协作记录">
        {unique.map(item => {
          const incoming = viewerBotId === item.targetBotId;
          const partnerId = incoming ? item.sourceBotId : item.targetBotId;
          const partnerName = incoming ? item.sourceDisplayName : item.targetDisplayName;
          return <button type="button" className="bot-collaboration-summary" key={item.collaborationId}
          data-collaboration-id={item.collaborationId} onClick={() => onOpenCollaboration?.(item.collaborationId)} disabled={!onOpenCollaboration}
          aria-label={`查看与 ${partnerName} 的协作记录，${item.messageCount} 条消息`}>
          <span className="bot-collaboration-summary-target"><BotAvatar botId={partnerId} name={partnerName} /><span title={partnerName}>{partnerName}</span></span>
          <span className="bot-collaboration-summary-count">{item.messageCount} 条消息</span>
          <span className="bot-collaboration-summary-meta"><span className="bot-collaboration-summary-status">{collaborationStatus(item.status)}{item.work ? ` · ${collaborationWorkStatus(item.work)}` : item.workId ? ' · 已关联事项' : ''}</span><span data-collaboration-elapsed>耗时 {collaborationElapsed(item, now)}</span></span>
          <IconChevronRight size={13} />
        </button>})}
      </div>
      {Boolean(legacy?.length) && <BotCallThread calls={legacy} renderReply={renderReply} />}
    </>;
  }
  if (!calls?.length) return null;
  const targets = new Map(calls.map(call => [call.targetBotId, call.targetDisplayName]));
  const count = calls.reduce((total, call) => total + Number(Boolean(call.requestText.trim())) + Number(Boolean(call.replyText?.trim())), 0);
  const participants = targets.size === 1 ? [...targets.values()][0] : `${targets.size} 个 Bot`;
  return <details className="bot-call-thread" aria-label="Bot 间通信记录">
    <summary>
      <span className="bot-call-summary">{count} 条消息，与 {participants}</span>
      {calls.length > 0 && <span className="bot-call-summary-status" role="status">{calls.map(call => <span key={call.callId} data-call-status={call.status}>{callStatus(call)}</span>)}</span>}
    </summary>
    <ol className="bot-call-exchanges">
      {calls.map(call => <li key={call.callId} className="bot-call-exchange" data-call-id={call.callId} data-call-status={call.status}>
        {call.requestText.trim() && <div className="bot-call-request">
          <div className="bot-call-author"><BotAvatar botId={call.sourceBotId} name={call.sourceDisplayName} /><strong>{call.sourceDisplayName}</strong><span>→ @{call.targetDisplayName}</span></div>
          <p className="bot-call-text">{call.requestText}</p>
        </div>}
        {call.replyText?.trim() && <div className="bot-call-reply">
          <div className="bot-call-author"><BotAvatar botId={call.targetBotId} name={call.targetDisplayName} /><strong>{call.targetDisplayName}</strong><span>回复 {call.sourceDisplayName}</span></div>
          <div className="bot-call-text bot-call-markdown">{renderReply ? renderReply(call.replyText, call.status === "running") : call.replyText}</div>
        </div>}
        <p className="bot-call-state">{callStatus(call)}</p>
      </li>)}
    </ol>
  </details>;
}
