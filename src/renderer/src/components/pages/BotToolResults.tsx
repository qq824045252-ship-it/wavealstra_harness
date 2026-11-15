import type { ChatToolCallDto } from "@shared/agent-ipc";
import ToolCallCard from "@/components/chat/ToolCallCard";
import WebSearchCard from "@/components/chat/WebSearchCard";

/** Host-projected tool results reuse the same presentation as an ordinary chat. */
export default function BotToolResults({ tools, messageId, taskId, onSearchFollowup }: {
  tools?: ChatToolCallDto[];
  messageId: string;
  taskId?: string;
  onSearchFollowup?: (text: string) => void;
}): React.JSX.Element | null {
  if (!tools?.length) return null;
  const searches = tools.filter(tool => tool.webSearch);
  return <div className="bot-capability-tools" aria-label="本次回复的工具结果">{tools.map(tool => tool.webSearch
    ? tool.id === searches[0]?.id ? <WebSearchCard key={tool.id} toolCall={tool} toolCalls={searches} onFollowup={onSearchFollowup ?? null} /> : null
    : <ToolCallCard key={tool.id} messageId={messageId} taskId={taskId} toolCall={tool} onSearchFollowup={onSearchFollowup ?? null} />)}</div>;
}
