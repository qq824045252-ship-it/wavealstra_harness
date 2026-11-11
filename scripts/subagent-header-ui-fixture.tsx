import { createRoot } from "react-dom/client";
import { useState } from "react";
import SubagentChatHeader from "../src/renderer/src/components/chat/SubagentChatHeader";
import { buildModelBadge } from "../src/renderer/src/lib/modelBadge";
import "../src/renderer/src/styles/global.css";
import { BotReplyMetrics } from "../src/renderer/src/components/pages/BotReplyMetrics";
import { WorkExecutionMetrics } from "../src/renderer/src/components/pages/WorkExecutionMetrics";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import type { WorkProjectionDto } from "../src/shared/bot-work";

function Fixture() {
  const [scenario, setScenario] = useState("measured");
  const [back, setBack] = useState(0);
  (window as any).setScenario = setScenario;
  const metrics = scenario === "missing" ? undefined : {
    totalInputTokens: 1_000_000, inputTokens: scenario === "other" ? 1_000_000 : 125_000,
    outputTokens: 22_000, cacheReadTokens: scenario === "partial" ? null : scenario === "other" ? 0 : 875_000,
    cacheWriteTokens: 0, durationMs: 12_000, contextTokens: 100_000, contextWindow: 1_000_000,
    reportedCalls: 1, calls: 1, complete: true, observedAt: 1,
  };
  return <div id="column" style={{ width: "1200px", background: "var(--bg-panel)" }}>
    <SubagentChatHeader taskTitle={"请在当前工作目录 C:\\Users\\servi\\Documents\\GitHub\\wavealstra_harness 分析输入框与子代理界面".repeat(3)}
      name="小火龙 · 输入框调查" subagentId="child-A" stateLabel={scenario === "running" ? "运行中" : "已完成"}
      stateTone={scenario === "running" ? "running" : "completed"}
      model={buildModelBadge("opendesign/deepseek-v4.1-flash", { displayName: "DeepSeek V4.1 Flash · Open Design" })}
      usage={scenario === "missing" ? undefined : scenario === "other" ? { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, turns: 1 } : { input: 125000, output: 22000, cacheRead: 875000, cacheWrite: 0, turns: 24 }}
      elapsed={scenario === "missing" ? undefined : scenario === "running" ? "3m 12s" : "16m 56s"}
      elapsedTitle="本子代理首末消息的时间跨度，非纯模型生成耗时" onBack={() => setBack(n => n + 1)} />
    <p id="body-marker" style={{ padding: 24 }}>子代理对话正文：不应被头部或指标遮挡。</p>
    <section id="bot-reply"><h2>个人 Bot 回复</h2><BotReplyMetrics message={{role:"assistant",status:"completed",createdAt:1,metrics} as BotMessageDto}/></section>
    <section id="team-reply"><h2>团队 Bot 回复（相同组件）</h2><BotReplyMetrics message={{role:"assistant",status:"completed",createdAt:1,metrics} as BotMessageDto}/></section>
    <section id="work-metrics"><WorkExecutionMetrics work={{executions:[{bindingId:"binding",botId:"bot",status:"completed",settledAt:20000,metrics}]} as unknown as WorkProjectionDto}/></section>
    <output id="back-count">{back}</output>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
