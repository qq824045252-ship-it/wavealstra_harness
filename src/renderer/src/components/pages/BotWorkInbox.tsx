import { useEffect, useState } from "react";
import type { BotMessageDto } from "@shared/bot-conversation";
import type { WorkProjectionDto } from "@shared/bot-work";
import ChatMarkdown from "@/components/chat/ChatMarkdown";
import { BotResultReport } from "./BotWorkResult";
import { botWorkTimeline } from "@/lib/botWorkspacePresentation";

/** Owner-scoped destination for work started outside a chat. Reading this inbox
 * never switches/archives the user's active conversation or starts a model turn. */
export function BotWorkInbox({ botId, works, onOpenWork }: {
  botId: string; works: WorkProjectionDto[]; onOpenWork: (id: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<BotMessageDto[]>([]);
  const [before, setBefore] = useState<number>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setMessages([]); setBefore(undefined); setError(""); setOpen(false);
    const refresh = async () => {
      try {
        const history = await window.api?.botWork.history({ botId, inbox: true });
        if (!alive || !history) return;
        setMessages(previous => [...new Map([...previous, ...history.messages].map(message => [message.messageId, message])).values()].sort((a, b) => a.ordinal - b.ordinal));
        setBefore(previous => previous === undefined ? history.before : history.before === undefined ? undefined : Math.min(previous, history.before));
        setError("");
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [botId]);
  const results = new Set(messages.filter(message => message.workFeedback?.category === "result").flatMap(message => message.workIds)).size;
  const render = (message: BotMessageDto) => <article key={message.messageId} className="bot-message" data-message-id={message.messageId}>
    {message.workFeedback?.report ? <BotResultReport message={message} work={works.find(work => work.workId === message.workFeedback?.workId)} renderMarkdown={text => <ChatMarkdown text={text} resolveTaskFiles={false} streaming={false} />} /> : <ChatMarkdown text={message.text} resolveTaskFiles={false} streaming={false} />}
    {message.workIds.map(id => <button type="button" key={id} onClick={() => onOpenWork(id)}>打开关联事项：{works.find(work => work.workId === id)?.title ?? message.workFeedback?.report?.title ?? "后台事项"}</button>)}
  </article>;
  return <section className="bot-work-inbox" aria-label="Bot 任务收件箱">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>任务收件箱{results ? ` · ${results} 项结果` : ""}</button>
    {open && <div className="bot-inbox-content" style={{ maxHeight: "45vh", overflow: "auto", padding: "12px" }}>
      <p>从组队或工作面板创建的事项在这里汇报；不会改变当前对话。</p>
      {error && <p role="alert">{error}</p>}
      {before && <button type="button" disabled={loading} onClick={async () => {
        setLoading(true);
        try {
          const history = await window.api?.botWork.history({ botId, inbox: true, before });
          if (history) { setMessages(previous => [...new Map([...history.messages, ...previous].map(message => [message.messageId, message])).values()].sort((a, b) => a.ordinal - b.ordinal)); setBefore(history.before); }
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setLoading(false); }
      }}>{loading ? "正在读取…" : "查看更早结果"}</button>}
      {!messages.length && <p>暂无回报。任务执行期间仍可继续聊天。</p>}
      {botWorkTimeline(messages).map(row => row.kind === "message" ? render(row.message) : <details key={row.key}><summary>{row.messages.length} 条执行记录</summary>{row.messages.map(render)}</details>)}
    </div>}
  </section>;
}
