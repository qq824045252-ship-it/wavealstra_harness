import assert from "node:assert/strict";
import type { BotHistoryDto, BotSendReceipt, BotSendRequest, WorkListUpdate } from "../src/shared/bot-conversation";
import type { WorkProjectionDto } from "../src/shared/bot-work";
import { createAppStore } from "../src/renderer/src/store/app/createAppStore";
import { mergeWorkList } from "../src/renderer/src/store/app/slices/botWorkSync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  const calls: BotSendRequest[] = [];
  const durable = new Map<string, BotSendReceipt>();
  const cancelled: string[] = [];
  const history = (botId: string): BotHistoryDto => ({ botId, conversationId: `conversation-${botId}`, revision: 1, archived: false, messages: [] });
  let send: (request: BotSendRequest) => Promise<BotSendReceipt> = async request => {
    const receipt = durable.get(request.requestId) ?? { botId: request.botId, conversationId: `conversation-${request.botId}`,
      requestId: request.requestId, userMessageId: `user-${request.requestId}`, assistantMessageId: `assistant-${request.requestId}`, replayed: false };
    durable.set(request.requestId, receipt); return receipt;
  };
  let read: (botId: string) => Promise<BotHistoryDto> = async botId => history(botId);
  let archived = false;
  const api = { botWork: {
    sendMessage: async (request: BotSendRequest) => { calls.push(request); return send(request); },
    history: ({ botId }: { botId: string }) => read(botId),
    listBots: async () => [{ botId: "a" }, { botId: "b" }],
    syncWorks: async (): Promise<WorkListUpdate> => ({ kind: "snapshot", cursor: { epoch: "ui", sequence: 0, scope: "open" }, works: [] }),
    hostStatus: async () => ({ online: true, isAuthority: true, authorityId: "ui-host" }),
    cancelSend: async (botId: string, requestId: string) => { cancelled.push(`${botId}:${requestId}`); },
    archiveConversation: async () => { archived = true; },
  } } as unknown as Window["api"];
  const store = createAppStore({ getApi: () => api }).useAppStore;
  return { store, calls, durable, cancelled, history, isArchived: () => archived,
    sender: (value: typeof send) => { send = value; }, reader: (value: typeof read) => { read = value; } };
}

async function main() {
  const f = fixture();
  const taskDraft = { title: "普通 Task 草稿" };
  f.store.setState({ activeBotId: "a", activeTaskId: "ordinary-task", draft: taskDraft, botDraft: "", selectedWorkId: "work-a" });
  const receipt = deferred<BotSendReceipt>(); f.sender(() => receipt.promise);
  f.store.getState().setBotDraft("给 A 的消息");
  const first = f.store.getState().submitBotDraft();
  await f.store.getState().submitBotDraft();
  assert.equal(f.calls.length, 1, "repeat click does not allocate another request");
  assert.equal(f.store.getState().botDraft, "给 A 的消息", "draft clears only after host accepts");
  f.store.getState().setActiveBotId("b");
  f.store.getState().setBotDraft("给 B 的草稿");
  const request = f.calls[0];
  receipt.resolve({ botId: "a", conversationId: "conversation-a", requestId: request.requestId, userMessageId: "user-a", assistantMessageId: "assistant-a", replayed: false });
  await first;
  assert.equal(f.calls[0].selectedWorkId, "work-a");
  assert.equal(f.store.getState().activeBotId, "b");
  assert.equal(f.store.getState().botDraft, "给 B 的草稿", "late A acknowledgement cannot clear B draft");
  assert.equal(f.store.getState().botDrafts.a, "");
  assert.equal(f.store.getState().draft, taskDraft);
  assert.equal(f.store.getState().activeTaskId, "ordinary-task");
  f.store.getState().setActiveBotId("a");
  assert.equal(f.store.getState().botDraft, "");
  f.store.getState().setActiveBotId("b");
  assert.equal(f.store.getState().botDraft, "给 B 的草稿");

  const lost = fixture(); lost.store.setState({ activeBotId: "a" });
  let attempts = 0;
  lost.sender(async input => {
    const response = lost.durable.get(input.requestId) ?? { botId: input.botId, requestId: input.requestId, conversationId: "conversation-a", userMessageId: "user", assistantMessageId: "assistant", replayed: false };
    lost.durable.set(input.requestId, response);
    if (++attempts === 1) throw new Error("accepted, acknowledgement lost");
    return { ...response, replayed: true };
  });
  lost.store.getState().setBotDraft("原始消息");
  await lost.store.getState().submitBotDraft();
  assert.equal(lost.store.getState().botDraft, "原始消息");
  const originalId = lost.calls[0].requestId;
  lost.store.getState().setBotDraft("在等待时修改的草稿");
  await lost.store.getState().submitBotDraft();
  assert.equal(lost.calls[1].requestId, originalId);
  assert.equal(lost.calls[1].text, "原始消息");
  assert.equal(lost.durable.size, 1);
  assert.equal(lost.store.getState().botDraft, "在等待时修改的草稿", "accepting original request must preserve edited text");

  const old = deferred<BotHistoryDto>();
  let reads = 0;
  lost.reader(async () => ++reads === 1 ? old.promise : { ...lost.history("a"), revision: 5 });
  const oldRead = lost.store.getState().refreshBotHistory("a");
  await lost.store.getState().refreshBotHistory("a");
  old.resolve({ ...lost.history("a"), revision: 2 }); await oldRead;
  assert.equal(lost.store.getState().botHistories.a.revision, 5);
  await lost.store.getState().cancelBotSend("a", originalId);
  assert.deepEqual(lost.cancelled, [`a:${originalId}`]);
  await lost.store.getState().archiveBotConversation("a");
  assert(lost.isArchived());

  const work: WorkProjectionDto = { workId: "one", title: "one", mode: "once", lifecycle: "active", ownerBotId: "a", ownerEpoch: 1,
    intentRevision: 1, sourceVersion: 1, stateVersion: 1, inputSnapshotId: "input", inputSnapshotBound: true, goalSources: [], criteria: [],
    acceptedDeliverableIds: [], deliverables: [], blockers: [], executions: [], notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: [], updatedAt: 1 };
  const cursor = { epoch: "durable-epoch", sequence: 5, scope: "open" as const };
  const removed = mergeWorkList([work], cursor, { kind: "delta", from: 5, cursor: { ...cursor, sequence: 6 },
    events: [{ kind: "remove", sequence: 6, workId: work.workId, reason: "closed", stateVersion: 2 }], hasMore: false });
  assert(removed); assert.deepEqual(removed.works, []);
  const stale = { kind: "snapshot" as const, cursor, works: [work] };
  assert.deepEqual(mergeWorkList(removed.works, removed.cursor, stale)?.works, [], "old snapshot cannot resurrect a removed card");
  const duplicate = { kind: "delta" as const, from: 4, cursor, events: [{ kind: "upsert" as const, sequence: 5, projection: work }], hasMore: false };
  assert.deepEqual(mergeWorkList(removed.works, removed.cursor, duplicate)?.works, []);
  assert.equal(mergeWorkList([], cursor, { ...duplicate, from: 6, cursor: { ...cursor, sequence: 7 } }), undefined, "gap requires full snapshot");
  assert.equal(mergeWorkList([], cursor, { ...duplicate, cursor: { ...cursor, epoch: "new-epoch" } }), undefined);
  assert.equal(mergeWorkList([], cursor, { ...duplicate, cursor: { ...cursor, scope: "all" } }), undefined);
  console.log("PASS Bot UI actual store sending: repeated clicks, per-Bot/Task draft isolation, lost acknowledgement identity, late history, cancel/archive, tombstone/gap/epoch");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
