import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BotWorkBrowser } from "../src/renderer/src/components/pages/BotWorkBrowser";
import { BotWorkNavigation } from "../src/renderer/src/components/pages/BotWorkNavigation";
import type { BotWorkspaceView } from "../src/renderer/src/lib/botWorkspacePresentation";
import { useAppStore } from "../src/renderer/src/store/appStore";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
const bridge = (window as unknown as { archiveFixture: { call(method: string, request?: unknown): Promise<unknown> } }).archiveFixture;
Object.assign(window, { api: { botWork: { reviewControl: (request: unknown) => bridge.call("control", request), queryWorks: (request: unknown) => bridge.call("query", request) } } });
useAppStore.setState({ refreshBotWork: async () => { useAppStore.setState(state => ({botWorkCursor:{epoch:"archive-fixture",sequence:(state.botWorkCursor?.sequence ?? 0)+1,scope:"all"}})); } });
function Fixture() {
  const [view, setView] = useState<BotWorkspaceView>("completed");
  return <div className="bot-workspace"><BotWorkNavigation scope={{kind:"all"}} view={view} onChange={setView} />
    {view !== "conversation" && <BotWorkBrowser key={view} scope={{kind:"all"}} view={view} onOpenWork={() => {}} onConversation={() => setView("conversation")} />}</div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
