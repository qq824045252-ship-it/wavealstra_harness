import { createRoot } from "react-dom/client";
import { BotMessage } from "../src/renderer/src/components/pages/BotWorkspacePage";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
const message: BotMessageDto = { messageId: "result-1", conversationId: "owner-conversation", botId: "owner", requestId: "delivery", ordinal: 1,
  role: "assistant", status: "completed", text: "合作项目已核对，原始凭据仍缺失。", workIds: ["team-1"], createdAt: 1, updatedAt: 1,
  workFeedback: { workId: "team-1", eventId: "result", kind: "result", category: "result", report: {
    title: "合作完成一个项目", summary: "14 项复算一致，2 项已纠正；真实取数未实测。", artifactRefs: ["report.md"],
    files: [{ ref: "report.md", name: "项目核对.md", openPath: "/fixture/report.md" }], reviewStatus: "proposed", current: true, notices: [] } } };
Object.assign(window, { deliverySelected: [], deliveryOpened: [], api: { openFolder: async (path: string) => (window as unknown as { deliveryOpened: string[] }).deliveryOpened.push(path) } });
createRoot(document.getElementById("root")!).render(<div className="bot-workspace"><section className="bot-conversation"><div className="bot-thread"><BotMessage message={message} botName="MyBuddy" works={[]} onOpenWork={id => (window as unknown as { deliverySelected: string[] }).deliverySelected.push(id)} onCancel={() => {}} /></div><textarea aria-label="继续聊天" /></section></div>);
