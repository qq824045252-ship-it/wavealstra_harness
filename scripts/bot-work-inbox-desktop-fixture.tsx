import { createRoot } from "react-dom/client";
import { BotWorkInbox } from "../src/renderer/src/components/pages/BotWorkInbox";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
const message: BotMessageDto = { messageId: "result-1", conversationId: "owner-inbox", botId: "owner", requestId: "delivery", ordinal: 1,
  role: "assistant", status: "completed", text: "合作项目已核对，原始凭据仍缺失。", workIds: ["team-1"], createdAt: 1, updatedAt: 1,
  workFeedback: { workId: "team-1", eventId: "result", kind: "result", category: "result", report: {
    title: "合作完成一个项目", summary: "14 项复算一致，2 项已纠正；真实取数未实测。", artifactRefs: ["report.md"],
    files: [{ ref: "report.md", name: "项目核对.md", openPath: "/fixture/report.md" }], reviewStatus: "proposed", current: true, notices: [] } } };
Object.assign(window, { inboxSelected: [], inboxOpened: [], api: { botWork: { history: async (request: { inbox?: boolean }) => {
  if (!request.inbox) throw Error("must not switch current chat");
  return { conversationId: "owner-inbox", botId: "owner", revision: 1, archived: true, messages: [message] };
} }, openFolder: async (path: string) => (window as unknown as { inboxOpened: string[] }).inboxOpened.push(path) } });
createRoot(document.getElementById("root")!).render(<div><BotWorkInbox botId="owner" works={[]} onOpenWork={id => (window as unknown as { inboxSelected: string[] }).inboxSelected.push(id)} /><textarea aria-label="继续聊天" /></div>);
