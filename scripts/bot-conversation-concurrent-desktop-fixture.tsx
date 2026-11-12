import './bot-interface-dom-env';
import { emptyModePolicy } from "../src/shared/mode-profile";
/** Actual page/store in Chromium, controlled host replies (not model acceptance). */
import "../src/renderer/src/styles/global.css";
import "../src/renderer/src/styles/systemTypography.css";
import { createRoot } from "react-dom/client";
import BotWorkspacePage from "../src/renderer/src/components/pages/BotWorkspacePage";
import { useAppStore } from "../src/renderer/src/store/appStore";
import { mergeBotMessageEvent } from "../src/renderer/src/store/app/slices/botMessageStream";
import type { BotHistoryDto, BotHistoryRequest, BotMessageDto, BotSendRequest, BotSendReceipt } from "../src/shared/bot-conversation";
import type { BotDto } from "../src/shared/bot-work";
const requests: BotSendRequest[] = [], cancellations: string[] = [];
let paging = false, holdPage = false, releasePage: (() => void) | undefined;
const pagingCalls: BotHistoryRequest[] = [];
const historyPage = (request: BotHistoryRequest): BotHistoryDto => {
  let rows = history.messages.filter(message => message.ordinal < (request.before ?? Infinity) && message.ordinal > (request.after ?? 0));
  const more = rows.length > 100;
  rows = request.after === undefined ? rows.slice(-100) : rows.slice(0, 100);
  return { ...structuredClone(history), messages: structuredClone(rows), before: more || request.after !== undefined ? rows[0]?.ordinal : undefined };
};
const receipts = new Map<string, (receipt: BotSendReceipt) => void>();
let history: BotHistoryDto = { botId: "bot", conversationId: "chat", revision: 1, archived: false, messages: [] };
const publish = () => useAppStore.setState({ botHistories: { [history.botId]: structuredClone(history) } });
const bot = { botId: "bot", displayName: "并发助理", status: "active", authorization: { allowedScopes: [] } } as unknown as BotDto;
let enhanceResolve: ((value:{text:string})=>void)|undefined;
Object.assign(window, { api: {
  enhance: {prompt:()=>new Promise(resolve=>{enhanceResolve=resolve;})},
  agent: {listModels:async()=>[],getModeProfile:async()=>({policy:emptyModePolicy()}),getAppSettings:async()=>({skillModeFilterEnabled:false})},
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
  history: async (request: BotHistoryRequest) => {
    if (!paging) return structuredClone(history);
    pagingCalls.push(request);
    const result = historyPage(request);
    if (request.before && holdPage) await new Promise<void>(resolve => { releasePage = resolve; });
    return result;
  },
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
  pagingCalls,
  seedPaging: (teamId?: string) => {
    paging = true; holdPage = true; pagingCalls.length = 0;
    const conversationId = `page-${Date.now()}`;
    history = {botId: "bot", teamId, conversationId, revision: 1, archived: false,
      messages: Array.from({length: 250}, (_, i) => ({botId:"bot",conversationId,requestId:`paging-${i}`,messageId:`paging-${i}`,ordinal:i+1,
        role:i%2?"assistant":"user",text:`历史消息 ${i+1}\n\n` + "分页阅读位置测试。\n\n".repeat(i%2?3:1),status:"completed",messageRevision:1,workIds:[],createdAt:1,updatedAt:1}))};
    const key = teamId ? `team:${teamId}` : "bot";
    useAppStore.setState({activeBotId:"bot",activeTeam:teamId?{templateId:teamId,ownerBotId:"bot",name:"分页团队",members:[]} as never:null,
      botHistories:{[key]:historyPage({botId:"bot",teamId})},botHistoryPages:{},botPendingSends:{}});
  },
  releasePaging: () => { holdPage = false; releasePage?.(); releasePage = undefined; },
  appendPaging: async () => {
    const last=history.messages.at(-1)!;
    history.messages.push({...last,messageId:`paging-${last.ordinal}`,requestId:`paging-${last.ordinal}`,ordinal:last.ordinal+1,text:"新消息不抢位置"}); history.revision++;
    await useAppStore.getState().refreshBotHistory("bot",history.teamId);
  },
  seedScroll: () => {
    history.messages = Array.from({length: 24}, (_, i) => ({ botId: history.botId, conversationId: history.conversationId, requestId: `scroll-${i}`, messageId: `scroll-${i}`,
      ordinal: i + 1, role: i % 2 ? "assistant" as const : "user" as const,
      text: i % 2 ? `历史回复 ${i}\n\n` + "这是用于验证阅读位置的真实渲染段落。\n\n".repeat(4) : `历史问题 ${i}`,
      status: i === 19 || i === 23 ? "running" as const : "completed" as const,
      workIds: [], createdAt: Date.now(), updatedAt: Date.now(), messageRevision: 1 }));
    history.revision++; publish();
  },
  streamScroll: (index: number, text: string, status: "running" | "completed" = "running") => {
    const item = history.messages[index];
    history.messages[index] = {...item, text: item.text + text, status, messageRevision: (item.messageRevision ?? 0) + 1};
    history.revision++; publish();
  },
  switchScrollBot: () => {
    history = {...history, botId: "bot-2", conversationId: "bot-2-chat", messages: [], revision: 1};
    useAppStore.setState({activeBotId: "bot-2", botIdentities: [bot, {...bot, botId: "bot-2", displayName: "第二位助理"}]}); publish();
  },
  newScrollConversation: () => { history = {...history, conversationId: "new-chat", messages: [], revision: history.revision + 1}; publish(); },
  updateReply: (index: number, patch: Partial<BotMessageDto>) => {
    const message = history.messages.find(item => item.requestId === requests[index].requestId && item.role === "assistant")!;
    Object.assign(message, patch, { messageRevision: (message.messageRevision ?? 0) + 1 });
    history.revision++; publish();
  },
  setMetrics: (index: number, input: number) => {
    const message=history.messages.find(item=>item.requestId===requests[index].requestId && item.role==='assistant')!;
    message.metrics={totalInputTokens:input+30,evidenceVersion:1,inputTokens:input,outputTokens:20,cacheReadTokens:30,cacheWriteTokens:0,reportedCalls:1,contextTokens:120,contextWindow:1000,contextEstimated:true,
      generation:{phase:'complete',estimated:false,tps:40,outputTokens:20,startedAt:1,updatedAt:2,ttftMs:10,outcome:'completed'}};
    publish();
  },
  requests, cancellations, enhancePending: () => Boolean(enhanceResolve), resolveEnhance:(text:string)=>enhanceResolve?.({text}), draft: (text: string) => useAppStore.getState().setBotDraft(text),
  acknowledge: (index: number) => { const request = requests[index]; receipts.get(request.requestId)!({ botId: "bot", conversationId: "chat", requestId: request.requestId,
    userMessageId: `u-${request.requestId}`, assistantMessageId: `a-${request.requestId}`, replayed: false }); },
  answer: (index: number, text: string, revision: number, status: "running" | "completed") => {
    const message = history.messages.find(item => item.requestId === requests[index].requestId && item.role === "assistant")!;
    const event = { botId: "bot", conversationId: "chat", revision, message: { ...message, text, status, messageRevision: (message.messageRevision ?? 0) + 1 } };
    history = mergeBotMessageEvent(history, event)!; publish();
  },
} });
const fixtureRoot = createRoot(document.getElementById("root")!);
fixtureRoot.render(<BotWorkspacePage />);
Object.assign(window, { disposeConversationFixture: () => fixtureRoot.unmount() });
