import { createRoot } from "react-dom/client";
import { useState } from "react";
import { BotMessageActions } from "../src/renderer/src/components/pages/BotMessageActions";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import "../src/renderer/src/styles/global.css";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
const events: string[] = [];
Object.assign(window, { actionEvents: events });
function Fixture() {
  const [stopped, setStopped] = useState(false);
  return <main className="bot-workspace" style={{ display:"block", padding:16, height:"auto" }}><section style={{ maxWidth:760, margin:"auto" }}>
    {(["user", "running", "completed", "unknown"] as const).map((kind, i) => {
      const message = { messageId:`m${i}`, role:kind === "user" ? "user" : "assistant", status:kind === "user" || (i === 1 && stopped) ? "completed" : kind, text:"示例回复", createdAt:Date.now() } as BotMessageDto;
      return <article className={`bot-message ${message.role}`} data-case={kind} key={kind} style={{ marginBottom:28 }}>
        <div className="bot-assistant-content" style={{ marginBottom:8, overflowWrap:"anywhere" }}>{kind === "user" ? "今天杭州天气怎么样？" : kind === "completed" ? "## 完成的长报告\n" + "核对每个任务的结果，回复操作始终位于内容下方。".repeat(24) : "正在搜索实时信息…"}</div>
        <BotMessageActions message={message} onReply={() => events.push(`reply:${i}`)} onCancel={() => { events.push(`stop:${i}`); if(i === 1) setStopped(true); }} />
      </article>;
    })}
  </section></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
