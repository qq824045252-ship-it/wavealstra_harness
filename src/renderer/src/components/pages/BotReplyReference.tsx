import { botMessageDisplayText, type BotMessageDto } from "@shared/bot-conversation";

/** A source-question reference, not Markdown blockquotes inside the answer. */
export function BotReplyReference({ message }: { message: BotMessageDto }): React.JSX.Element {
  const text = botMessageDisplayText(message.text);
  const attachments = message.attachments?.map(item => item.name).join("、");
  const preview = text || attachments || "原消息无文本";
  return <details className="bot-reply-reference" aria-label="回复对应问题" data-source-message-id={message.messageId}>
    <summary><span className="bot-reply-reference-label">回复</span><span className="bot-reply-reference-preview">{preview}</span></summary>
    <div className="bot-reply-reference-original" tabIndex={0} aria-label="引用原消息全文">
      {text && <div>{text}</div>}
      {attachments && <div className="bot-reply-reference-attachments">附件：{attachments}</div>}
      {!text && !attachments && <div>原消息无文本</div>}
    </div>
  </details>;
}

/** Host-recorded peer delegation. The title is the delegated Work's name, never model prose. */
export function BotDelegationReference({ senderName, taskTitle }: { senderName: string; taskTitle?: string }): React.JSX.Element {
  const title = taskTitle?.trim();
  return <details className="bot-reply-reference bot-delegation-reference" aria-label="接受的委托">
    <summary><span className="bot-reply-reference-label">接受委托</span><span className="bot-reply-reference-preview">{title || `来自 ${senderName}`}</span></summary>
    <div className="bot-reply-reference-original" tabIndex={0} aria-label="委托来源">
      <div>来自 {senderName} 的 Bot 协作委托</div>
      <div>{title ? `事项：${title}` : "这次委托还没有绑定事项记录。"}</div>
    </div>
  </details>;
}
