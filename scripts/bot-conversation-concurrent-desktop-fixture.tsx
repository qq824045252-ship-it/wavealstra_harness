import { emptyModePolicy } from "../src/shared/mode-profile";
/** Actual page/store in Chromium, controlled host replies (not model acceptance). */
import "../src/renderer/src/styles/global.css";
import "../src/renderer/src/styles/systemTypography.css";
import { createRoot } from "react-dom/client";
import BotWorkspacePage from "../src/renderer/src/components/pages/BotWorkspacePage";
import { useAppStore } from "../src/renderer/src/store/appStore";
import { mergeBotMessageEvent } from "../src/renderer/src/store/app/slices/botMessageStream";
import type { BotHistoryDto, BotSendRequest, BotSendReceipt } from "../src/shared/bot-conversation";
import type { BotDto } from "../src/shared/bot-work";
const requests: BotSendRequest[] = [], cancellations: string[] = [];
const receipts = new Map<string, (receipt: BotSendReceipt) => void>();
let history: BotHistoryDto = { botId: "bot", conversationId: "chat", revision: 1, archived: false, messages: [] };
const publish = () => useAppStore.setState({ botHistories: { bot: structuredClone(history) } });
const bot = { botId: "bot", displayName: "并发助理", status: "active", authorization: { allowedScopes: [] } } as unknown as BotDto;
let enhanceResolve: ((value:{text:string})=>void)|undefined;
Object.assign(window, { api: {
  enhance: {prompt:()=>new Promise(resolve=>{enhanceResolve=resolve;})},
  agent: {getModeProfile:async()=>({policy:emptyModePolicy()}),getAppSettings:async()=>({skillModeFilterEnabled:false})},
  mcp: {listServers:async()=>[{name:"fixture-mcp",installed:true,disabled:false,endpoint:"stdio",transport:"stdio",sourceId:"fixture"}]},
  botWork: {
  getSettings: async()=>({settings:{botId:"bot",revision:0,workspacePath:"",effectiveWorkspacePath:"/fixture",spaceId:"bot-space",modelId:"model-a",expertId:"",skillIds:[],mcpIds:[],connectorIds:[]},
    models:[{id:"model-a",name:"Model A",available:true},{id:"model-b",name:"Model B",available:true}],
    experts:[{id:"fixture-expert",name:"Fixture expert",available:true}],skills:[{id:"fixture-skill",name:"Fixture skill",available:true}],
    mcps:[{id:"fixture-mcp",name:"fixture-mcp",available:true}],connectors:[{id:"fixture-connector",name:"Fixture connector",available:true}]}),
  sendMessage: (request: BotSendRequest) => {
    requests.push(request);
    const time = Date.now();
    history.messages.push({ botId: "bot", conversationId: "chat", requestId: request.requestId, messageId: `u-${request.requestId}`,
      ordinal: history.messages.length + 1, role: "user", text: request.text, status: "completed", workIds: [], createdAt: time, updatedAt: time, messageRevision: 1 });
    history.messages.push({ ...history.messages.at(-1)!, messageId: `a-${request.requestId}`, ordinal: history.messages.length + 1, role: "assistant", text: "", status: "running" });
    history.revision++; publish();
    return new Promise<BotSendReceipt>(resolve => receipts.set(request.requestId, resolve));
  },
  history: async () => structuredClone(history),
  cancelSend: async (_bot: string, requestId: string) => {
    cancellations.push(requestId);
    history.messages = history.messages.map(item => item.role === "assistant" && item.requestId === requestId ? { ...item, status: "cancelled", messageRevision: (item.messageRevision ?? 0) + 1 } : item);
    history.revision++; publish();
  },
} } });
useAppStore.setState({ activeBotId: "bot", botIdentities: [bot], botHistories: { bot: history }, botWorks: [], botPendingSends: {},
  experts:[{id:"fixture-expert",name:"Fixture expert",enabled:true,installed:true}] as never,
  skills:[{id:"fixture-skill",name:"Fixture skill",enabled:true,installed:true,description:"fixture"}] as never,
  connectors:[{id:"fixture-connector",name:"Fixture connector",enabled:true,installed:true}] as never,
  refreshConnectors:async()=>{},
  refreshBotWork: async () => {}, botHostStatus: { online: true } as never });
Object.assign(window, { concurrentFixture: {
  requests, cancellations, resolveEnhance:(text:string)=>enhanceResolve?.({text}), draft: (text: string) => useAppStore.getState().setBotDraft(text),
  acknowledge: (index: number) => { const request = requests[index]; receipts.get(request.requestId)!({ botId: "bot", conversationId: "chat", requestId: request.requestId,
    userMessageId: `u-${request.requestId}`, assistantMessageId: `a-${request.requestId}`, replayed: false }); },
  answer: (index: number, text: string, revision: number, status: "running" | "completed") => {
    const message = history.messages.find(item => item.requestId === requests[index].requestId && item.role === "assistant")!;
    const event = { botId: "bot", conversationId: "chat", revision, message: { ...message, text, status, messageRevision: (message.messageRevision ?? 0) + 1 } };
    history = mergeBotMessageEvent(history, event)!; publish();
  },
} });
createRoot(document.getElementById("root")!).render(<BotWorkspacePage />);
