import { useMemo } from "react";
import ChatMarkdown, { type ChatMarkdownProps } from "@/components/chat/ChatMarkdown";
import { botChatMarkdown } from "@/lib/botChatMarkdown";

export default function BotChatMarkdown({ text, ...props }: ChatMarkdownProps): React.JSX.Element {
  const view = useMemo(() => botChatMarkdown(text), [text]);
  return <>
    {view.text.trim() && <ChatMarkdown {...props} text={view.text} />}
    {(view.sourceOmitted || view.truncated) && <p className="bot-source-omitted" role="note">
      {view.sourceOmitted ? "完整网页或超长代码已收起。" : "回复较长，已限制对话中的展示长度。"}
    </p>}
  </>;
}
