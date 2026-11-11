import assert from "node:assert/strict";
import { createAppStore } from "../src/renderer/src/store/app/createAppStore";
import { mergeBotMessageEvent } from "../src/renderer/src/store/app/slices/botMessageStream";
import type { BotHistoryDto, BotHistoryRequest, BotMessageDto } from "../src/shared/bot-conversation";
const msg = (ordinal: number): BotMessageDto => ({ botId: "a", conversationId: "chat", messageId: `m${ordinal}`, requestId: `r${ordinal}`,
  ordinal, role: "assistant", status: "running", text: `message ${ordinal}`, messageRevision: 1, workIds: [], createdAt: 1, updatedAt: 1 });
const page = (from: number, to: number, before?: number): BotHistoryDto => ({ botId: "a", conversationId: "chat", revision: 1,
  archived: false, messages: Array.from({length: to - from + 1}, (_, i) => msg(from + i)), before });
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; };
async function main() {
  const calls: BotHistoryRequest[] = [];
  let read = async (_request: BotHistoryRequest) => page(201, 300, 201);
  const api = { botWork: { history: async (request: BotHistoryRequest) => { calls.push(request); return request.messageIds ? {...store.getState().botHistories.a,messages:store.getState().botHistories.a.messages.filter(message=>request.messageIds!.includes(message.messageId)).map(message=>({...message,status:"completed" as const,messageRevision:10})),revision:10} : read(request); } } } as unknown as Window["api"];
  const store = createAppStore({ getApi: () => api }).useAppStore;
  await store.getState().refreshBotHistory("a");
  assert.equal(store.getState().botHistories.a.messages.length, 100);
  const delayed = defer<BotHistoryDto>(); read = request => request.before ? delayed.promise : Promise.resolve(page(203, 302, 203));
  const older = store.getState().loadOlderBotHistory("a");
  await store.getState().loadOlderBotHistory("a");
  assert.equal(calls.filter(call => call.before).length, 1, "repeat load is coalesced");
  assert.deepEqual(calls.at(-1), {botId: "a", teamId: undefined, conversationId: "chat", before: 201});
  await store.getState().refreshBotHistory("a");
  const streamed = mergeBotMessageEvent(store.getState().botHistories.a, {botId:"a",conversationId:"chat",revision:3,
    message: {...msg(250),text:"new streamed text",messageRevision:3}})!;
  store.setState({botHistories:{a:streamed}});
  delayed.resolve(page(101, 200, 101)); await older;
  assert.equal(store.getState().botHistories.a.messages.length, 202);
  assert.equal(store.getState().botHistories.a.messages.find(m=>m.ordinal===250)?.text,"new streamed text");
  assert.equal(store.getState().botHistories.a.before,101);
  read = async () => page(203,302,203); await store.getState().refreshBotHistory("a");
  assert.equal(store.getState().botHistories.a.messages.length,202,"latest refresh preserves prefix");
  assert.equal(store.getState().botHistories.a.messages.find(m=>m.ordinal===250)?.text,"new streamed text","old poll cannot clobber stream");
  read = async () => page(1,100); await store.getState().loadOlderBotHistory("a");
  assert.equal(store.getState().botHistories.a.messages.length,302);
  const count = calls.length; await store.getState().loadOlderBotHistory("a"); assert.equal(calls.length,count,"EOF makes no request");
  // A large burst catches up in bounded ascending pages, rather than skipping its middle.
  read = async request => request.after !== undefined ? page(request.after+1,Math.min(request.after+100,700),request.after+1) : page(601,700,601);
  for (let i=0;i<4;i++) await store.getState().refreshBotHistory("a");
  assert.equal(store.getState().botHistories.a.messages.length,700);
  assert.deepEqual(store.getState().botHistories.a.messages.map(m=>m.ordinal),Array.from({length:700},(_,i)=>i+1));
  assert.equal(store.getState().botHistories.a.before,undefined);
  store.setState({botHistories:{a:{...page(1,300),messages:page(1,300).messages.map(message=>({...message,status:message.ordinal===50?"running":"completed"}))}}});
  read = async () => page(201,300,201); await store.getState().refreshBotHistory("a");
  assert.equal(store.getState().botHistories.a.messages.find(message=>message.ordinal===50)?.status,"completed","off-page unfinished reply reconciles after missing stream event");
  assert(calls.some(call=>call.messageIds?.includes("m50")));
  // Conversation replacement cancels late pagination, including its pending/error state.
  store.setState({botHistories:{a:page(201,300,201)}});
  const stale = defer<BotHistoryDto>(); read = request => request.before ? stale.promise : Promise.resolve({...page(1,0),conversationId:"new-chat"});
  const old = store.getState().loadOlderBotHistory("a"); await store.getState().refreshBotHistory("a");
  stale.resolve(page(101,200,101)); await old;
  assert.equal(store.getState().botHistories.a.conversationId,"new-chat"); assert.equal(store.getState().botHistoryPages.a.loading,false);
  store.setState({botHistories:{a:page(201,300,201)}});
  read = async () => ({...page(101,200,101),teamId:"foreign"}); await store.getState().loadOlderBotHistory("a");
  assert.match(store.getState().botHistoryPages.a.error!,/不匹配/); assert.equal(store.getState().botHistories.a.messages.length,100);
  read = async () => { throw Error("offline fixture"); }; await store.getState().loadOlderBotHistory("a");
  assert.equal(store.getState().botHistoryPages.a.loading,false); assert.equal(store.getState().botHistories.a.before,201);
  read = async () => page(101,200,101); await store.getState().loadOlderBotHistory("a");
  assert.equal(store.getState().botHistories.a.messages.length,200); assert.equal(store.getState().botHistoryPages.a.error,undefined);
  console.log("PASS bounded history: repeated load, concurrent latest/stream merge, EOF, burst catch-up, conversation replacement, wrong scope and retry");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
