import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkProjectionDto } from "../src/shared/bot-work";
import { BotWorkBrowser } from "../src/renderer/src/components/pages/BotWorkBrowser";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";

const works: WorkProjectionDto[] = Array.from({ length: 137 }, (_, index) => {
  const id = `work-${index}`;
  const status = ["running", "pending", "completed", "unknown", "failed"][index % 7];
  return { workId: id, title: `委托 ${String(index).padStart(3, "0")} · 整理产品资料与交付记录`, mode: index % 7 === 5 ? "watch" : "once", lifecycle: index % 7 === 6 ? "paused" : "active",
    ownerBotId: "owner", ownerEpoch: 1, intentRevision: 1, sourceVersion: 1, stateVersion: 1, inputSnapshotId: "input", inputSnapshotBound: true,
    goalSources: [], criteria: [{ id: `criterion-${index}`, text: `核对供应商 ACME 的技术资料 ${index}`, status: "pending", requiredIntentRevision: 1, requiresRealEnvironmentCheck: false, evidenceRefs: [] }],
    acceptedDeliverableIds: [], deliverables: [], blockers: [],
    executions: status ? [{ bindingId: `binding-${index}`, workId: id, intentRevision: 1, inputSnapshotId: "input", ownerEpoch: 1, status } as WorkProjectionDto["executions"][number]] : [],
    notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: ["核对原始要求，保留完整报告与文件，不重复执行已有动作。"], updatedAt: Date.now() + index };
});
Object.assign(window, { browserFixtureWorks: works, browserFixtureSelected: [] });
function Fixture() {
  const [items, setItems] = useState(works);
  const [view, setView] = useState<"active" | "closed">("active");
  const [selected, setSelected] = useState<string | null>(null);
  Object.assign(window, { refreshBrowserFixture: (items: WorkProjectionDto[]) => setItems(items), setBrowserFixtureView: setView });
  return <StrictMode><div className="bot-workspace"><div className="bot-conversation"><BotWorkBrowser key={view} works={items} view={view} loading={false} selectedWorkId={selected} onConversation={() => {}} onOpenWork={id => { setSelected(id); (window as unknown as { browserFixtureSelected: string[] }).browserFixtureSelected.push(id); }} /></div></div></StrictMode>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
