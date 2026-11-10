import { createRoot } from "react-dom/client";
import { useState } from "react";
import SubagentChatHeader from "../src/renderer/src/components/chat/SubagentChatHeader";
import { buildModelBadge } from "../src/renderer/src/lib/modelBadge";
import "../src/renderer/src/styles/global.css";

function Fixture() {
  const [scenario, setScenario] = useState("measured");
  const [back, setBack] = useState(0);
  (window as any).setScenario = setScenario;
  return <div id="column" style={{ width: "1200px", background: "var(--bg-panel)" }}>
    <SubagentChatHeader taskTitle={"请在当前工作目录 C:\\Users\\servi\\Documents\\GitHub\\wavealstra_harness 分析输入框与子代理界面".repeat(3)}
      name="小火龙 · 输入框调查" subagentId="child-A" stateLabel={scenario === "running" ? "运行中" : "已完成"}
      stateTone={scenario === "running" ? "running" : "completed"}
      model={buildModelBadge("opendesign/deepseek-v4.1-flash", { displayName: "DeepSeek V4.1 Flash · Open Design" })}
      usage={scenario === "missing" ? undefined : scenario === "other" ? { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, turns: 1 } : { input: 125000, output: 22000, cacheRead: 875000, cacheWrite: 0, turns: 24 }}
      elapsed={scenario === "missing" ? undefined : scenario === "running" ? "3m 12s" : "16m 56s"}
      elapsedTitle="本子代理首末消息的时间跨度，非纯模型生成耗时" onBack={() => setBack(n => n + 1)} />
    <p id="body-marker" style={{ padding: 24 }}>子代理对话正文：不应被头部或指标遮挡。</p>
    <output id="back-count">{back}</output>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
