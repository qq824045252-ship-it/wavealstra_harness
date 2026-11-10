import { createRoot } from "react-dom/client";
import { BotActivityMonitor } from "../src/renderer/src/components/pages/BotActivityMonitor";
import { useAppStore } from "../src/renderer/src/store/appStore";
import { tasks, works, bots, histories, subagents } from "./bot-activity-fixtures";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
const navigations: string[] = [];
window.addEventListener("mybuddy:open-team-work", event => navigations.push("team-work:" + (event as CustomEvent<{workId:string}>).detail.workId));
let activeRequests: import("../src/shared/bot-conversation").BotActiveRequestDto[] = [];
Object.assign(window, { monitorNavigations: navigations, monitorGetState: useAppStore.getState, monitorSetState: useAppStore.setState, monitorSetActive: (requests: typeof activeRequests) => { activeRequests = requests; } });
Object.defineProperty(window, "api", { value: { botWork: { listWorks: async () => useAppStore.getState().botWorks, activeRequests: async () => activeRequests, history: async () => ({ conversationId: "archived", botId: "owner", revision: 2, archived: true, messages: [{ ...histories.owner.messages[1], messageId: "old", conversationId: "archived", status: "completed", text: "旧请求最终结果" }] }) }, subagent: { active: async (id: string) => subagents[id as keyof typeof subagents] ?? [], onEvent: () => () => {} } }, configurable: true });
useAppStore.setState({ activeBotId: "owner", tasks, botWorks: works, botIdentities: bots, botHistories: histories,
  refreshBotWork: async () => {}, refreshBotHistory: async () => {}, botConversationErrors: {}, botWorkError: null,
  setActiveTask: id => { navigations.push("task:" + id); }, openSubagentView: (taskId, id) => { navigations.push("sub:" + taskId + ":" + id); },
  setActiveBotId: id => { navigations.push("bot:" + id); }, setSelectedWorkId: id => { navigations.push("work:" + id); }, setPage: page => { navigations.push("page:" + page); },
});
createRoot(document.getElementById("root")!).render(<div className="bot-workspace" style={{ justifyContent: "flex-end" }}><BotActivityMonitor onOpenBotMessage={id => navigations.push("message:" + id)} /></div>);
