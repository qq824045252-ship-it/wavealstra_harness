import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BotWorkBrowser } from "../src/renderer/src/components/pages/BotWorkBrowser";
import { BotWorkNavigation } from "../src/renderer/src/components/pages/BotWorkNavigation";
import type { WorkProjectionDto } from "../src/shared/bot-work";
import type { BotWorkspaceView } from "../src/renderer/src/lib/botWorkspacePresentation";
import { useAppStore } from "../src/renderer/src/store/appStore";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
const bridge = (window as unknown as { archiveFixture: { call(method: string, request?: unknown): Promise<unknown> } }).archiveFixture;
function Fixture() {
  const [works, setWorks] = useState<WorkProjectionDto[]>([]), [view, setView] = useState<BotWorkspaceView>("completed");
  useEffect(() => {
    const refresh = async () => setWorks(await bridge.call("list") as WorkProjectionDto[]);
    Object.assign(window, { api: { botWork: { reviewControl: (request: unknown) => bridge.call("control", request) } } });
    useAppStore.setState({ refreshBotWork: refresh }); void refresh();
  }, []);
  return <div className="bot-workspace"><BotWorkNavigation works={works} view={view} allWorksLoaded onChange={setView} />
    {view !== "conversation" && <BotWorkBrowser key={view} works={works} view={view} loading={false} onOpenWork={() => {}} onConversation={() => setView("conversation")} />}</div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
