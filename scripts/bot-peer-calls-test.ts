import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotPeerCallService } from "../src/main/agent/work/BotPeerCallService";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import type { BotConversationServiceOptions } from "../src/main/agent/work/BotConversationService";
import { WorkService } from "../src/main/agent/work/WorkService";

const root = mkdtempSync(join(tmpdir(), "bot-peer-unit-"));
const app = new AppDatabase(join(root, "app.db"));
const db = app.connection, bots = new BotRegistry(db), works = new WorkService(db, { bots });
const messages = new BotConversationRepository(db);
const events: string[] = [];
const originalOpen = DurableBotRuntime.open;
const receivers: Array<{ options: Parameters<typeof DurableBotRuntime.open>[0]; resolve: (text: string) => void }> = [];
let service: BotPeerCallService;
try {
  for (const id of ["source", "target", "other"]) bots.registerBot({ botId: id, userId: "u", displayName: id });
  bots.registerBot({ botId: "paused", userId: "u", displayName: "paused", status: "paused" });
  bots.registerBot({ botId: "foreign", userId: "foreign-user", displayName: "foreign" });
  const make = (id: string) => messages.accept("u", { botId: "source", requestId: id, text: `user input ${id}` });
  const a = make("a"), b = make("b");
  const options = { db, userId: "u", bots, works, directory: root,
    models: { getModel: () => ({ provider: "test", id: "model" }), getModels: () => [{ provider: "test", id: "model" }], getAvailable: async () => [{ provider: "test", id: "model" }] },
    defaultModel: () => "test/model", isAuthority: () => true, memorySearch: () => [], schedule: () => {}, wake: () => {},
  } as unknown as BotConversationServiceOptions;
  service = new BotPeerCallService(options, messages, id => events.push(id));
  DurableBotRuntime.open = async options => {
    let resolve!: (text: string) => void;
    const reply = new Promise<string>(yes => { resolve = yes; });
    receivers.push({ options, resolve });
    return { conversation: { id: "unit", commit: async () => undefined }, configure: async () => {}, resume: () => {},
      submit: async () => ({}), reply: () => reply, abort: async () => resolve(""), close: async () => resolve("") } as unknown as DurableBotRuntime;
  };
  await assert.rejects(service.call(a.assistantMessageId, "self", "source", "question"), /自己/);
  await assert.rejects(service.call(a.assistantMessageId, "foreign", "foreign", "question"), /当前用户/);
  assert.equal(messages.peerCalls.list(a.assistantMessageId).length, 0);
  const failed = await service.call(a.assistantMessageId, "paused", "paused", "question");
  assert.equal(failed.status, "failed"); assert.match(failed.error!, /暂停/); assert.equal(receivers.length, 0);
  const first = service.call(a.assistantMessageId, "op-a", "target", "request A");
  const duplicate = service.call(a.assistantMessageId, "op-a", "target", "request A");
  const second = service.call(b.assistantMessageId, "op-b", "other", "request B");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(receivers.length, 2, "same tool replay does not create another model runtime");
  assert.notEqual(receivers[0].options.directory, receivers[1].options.directory);
  assert.equal(receivers[0].options.toolAllowed?.("bot_ask"), false, "no recursive loops");
  assert.equal(receivers[0].options.toolAllowed?.("write"), false, "recipient cannot write on forwarded authority");
  assert(receivers[0].options.instructions().includes('"target"'));
  receivers[1].resolve("B original answer");
  assert.equal((await second).replyText, "B original answer");
  assert.equal(messages.message(a.assistantMessageId)!.botCalls!.at(-1)!.status, "running");
  receivers[0].resolve("A original answer");
  assert.equal((await first).replyText, "A original answer");
  assert.deepEqual(await duplicate, await first);
  const before = receivers.length;
  assert.equal((await service.call(a.assistantMessageId, "op-a", "target", "request A")).status, "completed");
  assert.equal(receivers.length, before, "terminal replay reads receipt without recontacting");
  await assert.rejects(service.call(a.assistantMessageId, "op-a", "other", "changed"), /不能换/);
  assert.equal(messages.history("u", { botId: "target" }).messages.length, 0, "forwarded questions never impersonate the user in target inbox");
  const c = make("c");
  const cancel = service.call(c.assistantMessageId, "cancel", "target", "cancel me");
  await new Promise(resolve => setTimeout(resolve, 20));
  await service.cancel(c.assistantMessageId);
  assert.equal((await cancel).status, "cancelled");
  const revision = messages.message(c.assistantMessageId)!.messageRevision!;
  assert(revision > 1, "call updates bump message revision for reconnect ordering");
  const d = make("d");
  const interrupted = service.call(d.assistantMessageId, "close", "target", "in flight");
  await new Promise(resolve => setTimeout(resolve, 20));
  await service.close();
  assert.equal((await interrupted).status, "unknown", "host interruption is not fabricated completion or permanent failure");
  assert.equal(messages.message(a.assistantMessageId)!.botCalls![1].replyText, "A original answer");
  assert.equal(messages.message(b.assistantMessageId)!.botCalls![0].replyText, "B original answer");
  assert(events.includes(a.assistantMessageId) && events.includes(b.assistantMessageId));
  console.log("PASS Bot peer-call scope, actual recipient identity, idempotency, parallel isolation, pause/failure, cancellation, recovery and durable UI projection");
} finally {
  DurableBotRuntime.open = originalOpen;
  app.close(); rmSync(root, { recursive: true, force: true });
}
