import { mergeBotMessageEvent } from "../src/renderer/src/store/app/slices/botMessageStream";
import assert from "node:assert/strict";
import type { BotHistoryDto, BotSendReceipt, BotSendRequest, WorkListUpdate } from "../src/shared/bot-conversation";
import type { BotDto, WorkProjectionDto } from "../src/shared/bot-work";
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
    listBots: async () => ["a", "b"].map(botId => ({ botId, userId: "user", status: "active", authorization: {} })),
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
  const message = { messageId: "answer", conversationId: "conversation-a", botId: "a", requestId: "request-a", ordinal: 2,
    role: "assistant" as const, text: "", status: "running" as const, workIds: [], createdAt: 1, updatedAt: 1 };
  const initial: BotHistoryDto = { botId: "a", conversationId: "conversation-a", revision: 1, archived: false, messages: [message] };
  const event = { botId: "a", conversationId: "conversation-a", revision: 2, message: { ...message, text: "first token" } };
  const streamed = mergeBotMessageEvent(initial, event)!;
  assert.equal(streamed.messages[0].text, "first token");
  assert.equal(mergeBotMessageEvent(streamed, event), streamed, "duplicate frame is idempotent");
  assert.equal(mergeBotMessageEvent(streamed, { ...event, revision: 1 }), streamed, "out-of-order frame ignored");
  assert.equal(mergeBotMessageEvent(initial, { ...event, botId: "b" }), initial, "other Bot cannot overwrite this history");
  assert.equal(mergeBotMessageEvent(initial, { ...event, conversationId: "archived" }), initial, "old conversation cannot overwrite new conversation");
  assert.equal(mergeBotMessageEvent(initial, { ...event, message: { ...event.message, requestId: "other-request" } }), initial);
  const stopped = { ...streamed, revision: 3, messages: [{ ...message, text: "first token", status: "cancelled" as const }] };
  assert.equal(mergeBotMessageEvent(stopped, { ...event, revision: 4 }), stopped, "late running frame cannot revive stopped message");
  assert.equal(mergeBotMessageEvent({ ...initial, archived: true }, event)?.archived, true);
  console.log("PASS Bot stream identity, revision ordering, duplicate, archive and cancellation fences");

  const parallelHistory = { ...initial, revision: 10, messages: [
    { ...message, messageRevision: 1 },
    { ...message, messageId: "answer-b", requestId: "request-b", ordinal: 4, messageRevision: 1 },
  ] };
  const bFirst = mergeBotMessageEvent(parallelHistory, { ...event, revision: 12,
    message: { ...parallelHistory.messages[1], text: "B completed first", status: "completed", messageRevision: 2 } })!;
  const aLater = mergeBotMessageEvent(bFirst, { ...event, revision: 11,
    message: { ...parallelHistory.messages[0], text: "A delayed frame", messageRevision: 2 } })!;
  assert.equal(aLater.messages[0].text, "A delayed frame");
  assert.equal(aLater.messages[1].text, "B completed first");
  assert.equal(aLater.revision, 12);
  assert.deepEqual(aLater.messages.map(item => item.messageId), ["answer", "answer-b"]);
  assert.equal(mergeBotMessageEvent(aLater, { ...event, revision: 13,
    message: { ...parallelHistory.messages[0], text: "stale A", messageRevision: 1 } }), aLater);

  const f = fixture();
  const taskDraft = { title: "普通 Task 草稿" };
  f.store.setState({ activeBotId: "a", activeTaskId: "ordinary-task", draft: taskDraft, botDraft: "", selectedWorkId: "work-a" });
  const receipt = deferred<BotSendReceipt>(); f.sender(() => receipt.promise);
  f.store.getState().setBotDraft("给 A 的消息");
  const first = f.store.getState().submitBotDraft();
  await f.store.getState().submitBotDraft();
  assert.equal(f.calls.length, 1, "repeat click does not allocate another request");
  assert.equal(f.store.getState().botDraft, "", "draft transfers to independent pending request immediately");
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
  assert.equal(lost.store.getState().botDraft, "");
  const originalId = lost.calls[0].requestId;
  lost.store.getState().setBotDraft("在等待时修改的草稿");
  await lost.store.getState().submitBotDraft({ retryRequestId: originalId });
  assert.equal(lost.calls[1].requestId, originalId);
  assert.equal(lost.calls[1].text, "原始消息");
  assert.equal(lost.durable.size, 1);
  assert.equal(lost.store.getState().botDraft, "在等待时修改的草稿", "accepting original request must preserve edited text");

  const concurrent = fixture(); concurrent.store.setState({ activeBotId: "a" });
  const replies = [deferred<BotSendReceipt>(), deferred<BotSendReceipt>()];
  concurrent.sender(request => replies[concurrent.calls.findIndex(item => item.requestId === request.requestId)].promise);
  concurrent.store.getState().setBotDraft("慢请求 A"); const pa = concurrent.store.getState().submitBotDraft();
  concurrent.store.getState().setBotDraft("快速请求 B"); const pb = concurrent.store.getState().submitBotDraft({ referenceMessageId: "original-question" });
  assert.equal(concurrent.calls.length, 2, "second request submits before first acknowledgement");
  assert.equal(Object.keys(concurrent.store.getState().botPendingSends).length, 2);
  assert.equal(concurrent.calls[1].referenceMessageId, "original-question");
  concurrent.store.getState().setBotDraft("第三条尚未发送");
  const ack = (i: number): BotSendReceipt => ({ botId: "a", conversationId: "conversation-a", requestId: concurrent.calls[i].requestId,
    userMessageId: `u${i}`, assistantMessageId: `a${i}`, replayed: false });
  replies[1].resolve(ack(1)); await pb;
  assert.deepEqual(Object.keys(concurrent.store.getState().botPendingSends), [concurrent.calls[0].requestId]);
  replies[0].resolve(ack(0)); await pa;
  assert.equal(concurrent.store.getState().botDraft, "第三条尚未发送");
  assert.equal(Object.keys(concurrent.store.getState().botPendingSends).length, 0);
  console.log("PASS concurrent sends, reverse acknowledgement order and independent reference");

  const files = fixture(); files.store.setState({ activeBotId: "a" });
  files.store.getState().setBotAttachments("a", [{ name: "report.txt", path: "/tmp/report.txt" }]);
  files.store.getState().setBotAttachments("b", [{ name: "other.png", path: "/tmp/other.png" }]);
  await files.store.getState().submitBotDraft();
  assert.equal(files.calls.length, 1, "attachment-only draft sends");
  assert.equal(files.calls[0].text, "");
  assert.deepEqual(files.calls[0].attachments, [{ name: "report.txt", path: "/tmp/report.txt" }]);
  assert.deepEqual(files.store.getState().botAttachmentDrafts.a, []);
  assert.equal(files.store.getState().botAttachmentDrafts.b[0].name, "other.png", "other Bot attachment draft survives");
  lost.store.getState().setBotAttachments("a", [{ name: "new.txt", path: "/tmp/new.txt" }]);
  const held = deferred<BotSendReceipt>(); lost.sender(() => held.promise);
  const pendingFile = lost.store.getState().submitBotDraft();
  const originalFile = lost.calls.at(-1)!;
  lost.store.getState().setBotAttachments("a", [{ name: "changed.txt", path: "/tmp/changed.txt" }]);
  held.resolve({ botId: "a", requestId: originalFile.requestId, conversationId: "conversation-a", userMessageId: "file-u", assistantMessageId: "file-a", replayed: false });
  await pendingFile;
  assert.equal(lost.store.getState().botAttachmentDrafts.a[0].name, "changed.txt", "late receipt preserves changed attachment draft");

  const rejected = fixture(); rejected.store.setState({ activeBotId: "a" });
  rejected.store.getState().setBotAttachments("a", [{ name: "missing.txt", path: "/tmp/missing.txt" }]);
  rejected.sender(async () => { throw new Error("BOT_ATTACHMENT_REJECTED: 附件不存在"); });
  await rejected.store.getState().submitBotDraft();
  await rejected.store.getState().submitBotDraft({ editRejectedRequestId: rejected.calls[0].requestId });
  assert.equal(Object.keys(rejected.store.getState().botPendingSends).length, 0, "definite rejection can be edited without duplicating an accepted request");
  assert.equal(rejected.store.getState().botAttachmentDrafts.a[0].name, "missing.txt", "rejection preserves editable draft");

  const rejectedId = rejected.calls[0].requestId;
  rejected.store.getState().setBotAttachments("a", [{ name: "present.txt", path: "/tmp/present.txt" }]);
  await rejected.store.getState().submitBotDraft();
  assert.notEqual(rejected.calls[1].requestId, rejectedId, "corrected request gets a new identity only after definitive rejection");
  assert.equal(rejected.calls[1].attachments?.[0].name, "present.txt");

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
  await testNavigationRecovery(work);
  console.log("PASS Bot UI actual store sending: repeated clicks, per-Bot/Task draft isolation, lost acknowledgement identity, late history, cancel/archive, tombstone/gap/epoch");
}

async function testNavigationRecovery(work: WorkProjectionDto) {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  const key = "mybuddy.bot-navigation";
  const bots = ["a", "b"].map(botId => ({ botId, userId: "user", status: "active", authorization: {} } as BotDto));
  const works = [{ ...work, workId: "work-a" }, { ...work, workId: "work-b", ownerBotId: "b", lifecycle: "paused" as const }];
  function navigationFixture() {
    let currentBots = bots;
    let currentWorks = works;
    let read: (() => Promise<WorkListUpdate>) | undefined;
    let syncs = 0;
    const api = { botWork: {
      listBots: async () => currentBots,
      syncWorks: async () => { syncs++; return read ? read() : { kind: "snapshot", cursor: { epoch: `nav-${syncs}`, sequence: 0, scope: "open" }, works: currentWorks }; },
      hostStatus: async () => ({ online: true, isAuthority: true, authorityId: "test" }),
      history: async ({ botId }: { botId: string }) => ({ botId, conversationId: botId, revision: 1, archived: false, messages: [] }),
    } } as unknown as Window["api"];
    const { useAppStore: store, context } = createAppStore({ getApi: () => api });
    return { store, context, setBots: (value: BotDto[]) => { currentBots = value; }, setWorks: (value: WorkProjectionDto[]) => { currentWorks = value; },
      setRead: (value: typeof read) => { read = value; }, syncs: () => syncs };
  }
  try {
    const first = navigationFixture();
    first.store.getState().initRuntime();
    assert.equal(first.syncs(), 0, "a first visit has no saved navigation to hydrate");
    assert.equal(first.store.getState().page, "chat");
    await first.store.getState().refreshBotWork();
    first.store.getState().setPage("bot");
    first.store.getState().setActiveBotId("b");
    first.store.getState().setSelectedWorkId("work-b");
    first.store.getState().setBotDraft("重启保留的草稿");
    const saved = values.get(key)!;
    assert.deepEqual(JSON.parse(saved), { version: 1, userId: "user", botId: "b", page: "bot", workId: "work-b" });

    const reboot = navigationFixture();
    const slow = deferred<WorkListUpdate>(); reboot.setRead(() => slow.promise);
    reboot.store.getState().initRuntime();
    assert.equal(reboot.syncs(), 1, "startup hydrates saved context even before Bot page mounts");
    assert.equal(reboot.store.getState().page, "chat", "unverified IDs are not restored synchronously");
    reboot.context.set(state => state);
    assert.equal(values.get(key), saved, "loading must not erase the saved location");
    slow.resolve({ kind: "snapshot", cursor: { epoch: "startup", sequence: 0, scope: "open" }, works });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reboot.store.getState().page, "bot");
    assert.equal(reboot.store.getState().activeBotId, "b");
    assert.equal(reboot.store.getState().selectedWorkId, "work-b", "paused Work selection recovers");
    assert.equal(reboot.store.getState().botDraft, "重启保留的草稿");
    reboot.store.getState().setPage("chat");
    const ordinary = navigationFixture();
    await ordinary.store.getState().refreshBotWork();
    assert.equal(ordinary.store.getState().page, "chat", "explicit ordinary mode survives restart");
    assert.equal(ordinary.store.getState().selectedWorkId, "work-b");

    for (const navigate of [
      (store: typeof ordinary.store) => store.getState().setPage("chat"),
      (store: typeof ordinary.store) => store.getState().setPage("library"),
      (store: typeof ordinary.store) => store.getState().startProjectTask({ projectId: "project", welcomeMode: "working", modePresetId: null }),
    ]) {
      values.set(key, saved);
      const late = navigationFixture();
      const delay = deferred<WorkListUpdate>(); late.setRead(() => delay.promise);
      const loading = late.store.getState().refreshBotWork();
      navigate(late.store);
      const chosenPage = late.store.getState().page;
      delay.resolve({ kind: "snapshot", cursor: { epoch: "late", sequence: 0, scope: "open" }, works });
      await loading;
      assert.equal(late.store.getState().page, chosenPage, "late load cannot override newer navigation, including a same-page write");
      assert.equal(late.store.getState().selectedWorkId, null, "cancelled restoration cannot bring back the old Work");
    }

    values.set(key, saved);
    const retry = navigationFixture();
    retry.setRead(async () => { throw new Error("temporarily offline"); });
    await retry.store.getState().refreshBotWork();
    assert.equal(values.get(key), saved, "failed initial sync preserves the cache for retry");
    retry.setRead(undefined); await retry.store.getState().refreshBotWork();
    assert.equal(retry.store.getState().page, "bot");
    assert.equal(retry.store.getState().selectedWorkId, "work-b");

    for (const invalidBots of [bots.slice(0, 1),
      bots.map(bot => ({ ...bot, userId: "other-user" })),
      bots.map(bot => ({ ...bot, status: "disabled" as const })),
      bots.map(bot => ({ ...bot, authorization: { ...bot.authorization, expiresAt: 1 } })),
    ]) {
      values.set(key, saved);
      const invalid = navigationFixture(); invalid.setBots(invalidBots);
      await invalid.store.getState().refreshBotWork();
      assert.equal(invalid.store.getState().page, "chat", "deleted, foreign, disabled or expired Bot cannot restore Bot mode");
      assert.equal(invalid.store.getState().selectedWorkId, null);
    }
    for (const invalidWorks of [[], [{ ...works[1], lifecycle: "closed" as const }], [{ ...works[1], ownerBotId: "a" }]]) {
      values.set(key, saved);
      const invalid = navigationFixture(); invalid.setWorks(invalidWorks);
      await invalid.store.getState().refreshBotWork();
      assert.equal(invalid.store.getState().page, "bot");
      assert.equal(invalid.store.getState().selectedWorkId, null, "missing, closed or transferred Work is not reselected");
      assert.equal(JSON.parse(values.get(key)!).workId, null);
    }

    values.set(key, saved);
    const live = navigationFixture(); await live.store.getState().refreshBotWork();
    live.setWorks([{ ...works[1], lifecycle: "closed" }]);
    await live.store.getState().refreshBotWork();
    assert.equal(live.store.getState().selectedWorkId, null, "closure clears selection in the open Work view");
    await live.store.getState().refreshBotWork(true);
    live.store.getState().setSelectedWorkId("work-b");
    await live.store.getState().refreshBotWork(true);
    assert.equal(live.store.getState().selectedWorkId, "work-b", "explicit closed-history inspection survives polling");
    assert.equal(JSON.parse(values.get(key)!).workId, null, "closed history selection must not be auto-restored on restart");
    live.setBots(bots.slice(0, 1)); await live.store.getState().refreshBotWork();
    assert.equal(live.store.getState().page, "chat", "loss of the active Bot safely leaves Bot mode");
    live.store.getState().setActiveBotId("a");
    assert.equal(live.store.getState().selectedWorkId, null, "switching Bot never carries a Work selection across owners");

    for (const readOnlyBot of [{ ...bots[1], status: "paused" as const }, { ...bots[1], status: "disabled" as const },
      { ...bots[1], authorization: { ...bots[1].authorization, expiresAt: 1 } }]) {
      values.delete(key);
      const inspect = navigationFixture(); inspect.setBots([bots[0], readOnlyBot]);
      await inspect.store.getState().refreshBotWork();
      inspect.store.getState().setActiveBotId("b"); inspect.store.getState().setPage("bot");
      await inspect.store.getState().refreshBotWork();
      assert.equal(inspect.store.getState().activeBotId, "b", "a visible but inactive Bot remains available for explicit read-only inspection");
      assert.equal(inspect.store.getState().page, "bot");
      assert.equal(values.has(key), false, "read-only inspection does not authorize automatic restoration");
    }

    values.set(key, "invalid json");
    const corrupt = navigationFixture(); await corrupt.store.getState().refreshBotWork();
    assert.equal(corrupt.store.getState().page, "chat");
    console.log("PASS Bot navigation recovery: validated user/Bot/Work scope, delayed loading, draft/mode restoration, ordinary navigation races, retry, close/delete/transfer/permission fallback");
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
