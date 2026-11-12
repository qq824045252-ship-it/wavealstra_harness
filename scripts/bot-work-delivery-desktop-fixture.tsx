import { createRoot } from "react-dom/client";
import { BotMessage } from "../src/renderer/src/components/pages/BotWorkspacePage";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import { works } from "./bot-activity-fixtures";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
const message: BotMessageDto = { messageId: "result-1", conversationId: "owner-conversation", botId: "owner", requestId: "delivery", ordinal: 1,
  role: "assistant", status: "completed", text: "合作项目已核对，原始凭据仍缺失。", workIds: ["team-1"], createdAt: 1, updatedAt: 1,
  workFeedback: { workId: "team-1", eventId: "result", kind: "result", category: "result", report: {
    title: "合作完成一个项目", summary: "14 项复算一致，2 项已纠正；真实取数未实测。", artifactRefs: ["report.md"],
    files: [{ ref: "report.md", name: "项目核对.md", openPath: "/fixture/report.md" }], reviewStatus: "proposed", current: true, notices: [] } } };
const milestone: BotMessageDto = { ...message, messageId: "milestone-1", text: "A 已核实可先使用；B 仍在执行。不代表整体目标已完成。",
  workFeedback: { workId: "team-1", eventId: "milestone:execution", executionId: "execution", kind: "binding", category: "progress", report: {
    title: "先使用已核实的 A", milestone: true, summary: "A 已核实可先使用；B 仍在执行。不代表整体目标已完成。",
    artifactRefs: ["/saved/A-v1.md", "/work/B.md", "/work/unregistered.md"],
    files: [{ ref: "/saved/A-v1.md", name: "A.md", openPath: "/saved/A-v1.md" }, { ref: "/work/B.md", name: "B.md" },
      { ref: "/work/unregistered.md", name: "unregistered.md" }], reviewStatus: "proposed", current: true, notices: [] } } };
const refreshedWork = { ...works[0], workId: "team-1", generatedArtifacts: [
  { bindingId: "execution", path: "/work/A.md", snapshotPath: "/saved/A-v2.md", digest: "new-a", sizeBytes: 10, registeredAt: 2, sourceEntryId: 2 },
  { bindingId: "execution", path: "/work/B.md", snapshotPath: "/saved/B-v2.md", digest: "new-b", sizeBytes: 10, registeredAt: 2, sourceEntryId: 2 },
] };
const root = createRoot(document.getElementById("root")!);
function render(mode: "result" | "milestone" | "refreshed" | "legacy" | "error") {
  const current = mode === "result" ? message : structuredClone(milestone);
  if (mode === "legacy") delete current.workFeedback!.report;
  Object.assign(window, { deliveryFailOpen: mode === "error" });
  root.render(<div key={mode} className="bot-workspace"><section className="bot-conversation"><div className="bot-thread"><BotMessage message={current} botName="MyBuddy" works={mode === "refreshed" ? [refreshedWork] : []} onOpenWork={id => (window as unknown as { deliverySelected: string[] }).deliverySelected.push(id)} onCancel={() => {}} /></div><textarea aria-label="继续聊天" /></section></div>);
}
Object.assign(window, { deliverySelected: [], deliveryOpened: [], deliveryFixture: { render }, api: { readWorkspaceFile: async (path: string) => {
  if ((window as unknown as { deliveryFailOpen: boolean }).deliveryFailOpen) throw Error("保存文件暂不可用");
  (window as unknown as { deliveryOpened: string[] }).deliveryOpened.push(path);
  return { content: `保存文本：${path}` };
} } });
render("result");
