import type { BotMessageDto } from "@shared/bot-conversation";
import { IconBtw, IconStop } from "@/components/common/icons";
import { botMessageStatus } from "@/lib/botWorkspacePresentation";

/** Per-message controls stay next to their message, not among its timestamps. */
export function BotMessageActions({ message, onReply, onCancel, statusAlreadyVisible = false }: {
  message: BotMessageDto; statusAlreadyVisible?: boolean; onReply?: () => void; onCancel: () => void;
}): React.JSX.Element {
  const running = message.role === "assistant" && ["queued", "running", "unknown"].includes(message.status);
  return <footer className="bot-message-meta">
    <div className="bot-message-actions" role="group" aria-label="消息操作">
      {onReply && <button type="button" className="bot-message-reply" onClick={onReply} aria-label="回复或补充这条消息" title="回复或补充这条消息"><IconBtw size={16} /></button>}
      {running && <button type="button" className="bot-message-stop" onClick={onCancel} aria-label="仅停止这条回复" title="仅停止这条回复，其他任务继续"><IconStop size={14} /></button>}
    </div>
    <div className="bot-message-stamp">
      {!statusAlreadyVisible && (message.text || !running) && <span role={running ? "status" : undefined}>{botMessageStatus(message)}</span>}
      <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
    </div>
  </footer>;
}
