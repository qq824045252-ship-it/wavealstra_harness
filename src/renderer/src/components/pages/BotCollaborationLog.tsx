import type { BotDto } from '@shared/bot-work';
import type { WorkCollaborationMessage } from '@shared/bot-work-collaboration';
import { WorkResultText } from './BotWorkResult';
import './BotCollaborationLog.css';

const labels: Record<WorkCollaborationMessage['kind'], string> = { delegate: '分工', accepted: '接手', question: '问题', result: '成果', blocked: '阻碍', change: '变更', cancel: '取消', handoff: '交接' };

/** Only fold exact repeats within the same sender, recipients and source version.
 * Every original message id and timestamp remains visible; stored records are untouched. */
export function BotCollaborationLog({ messages, identities }: { messages: WorkCollaborationMessage[]; identities: BotDto[] }): React.JSX.Element {
  const groups = new Map<string, WorkCollaborationMessage[]>();
  for (const message of messages) {
    const key = JSON.stringify([message.senderKind, message.senderBotId, message.recipientBotIds, message.kind,
      message.intentRevision, message.inputSnapshotId, message.ownerEpoch, message.body, message.artifactRefs, message.executionRefs]);
    const group = groups.get(key);
    if (group) group.push(message); else groups.set(key, [message]);
  }
  const name = (message: WorkCollaborationMessage) => message.senderBotId
    ? identities.find(bot => bot.botId === message.senderBotId)?.displayName.trim() || '成员名称不可用'
    : message.senderKind === 'user' ? '你' : '执行器';
  return <div className="bot-collaboration-log">{[...groups.values()].map(group => {
    const message = group[0];
    return <article key={message.messageId} className="bot-collaboration-entry">
      <header><strong>{name(message)}</strong><span>{labels[message.kind]}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString()}</time></header>
      <div className="bot-collaboration-body"><WorkResultText text={message.body} /></div>
      {group.length > 1 && <details className="bot-collaboration-repeats"><summary>相同内容另有 {group.length - 1} 条记录</summary>
        <ul>{group.slice(1).map(item => <li key={item.messageId}><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time> · <code>{item.messageId}</code></li>)}</ul>
      </details>}
    </article>;
  })}</div>;
}
