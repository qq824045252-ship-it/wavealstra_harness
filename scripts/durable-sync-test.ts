import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { durableDelta, applyDurableDelta, replayDurableDeltas } from "../shared/src/durable-sync";
import { REMOTE_API_VERSION, type RemoteEventEnvelope } from "../shared/src/remote-contract";
import { applyEvent, useRemoteStore } from "../app/remote/src/store/remoteStore";
import { RemoteClient } from "../app/remote/src/api/RemoteClient";
import { RemoteEventStream } from "../app/remote/src/api/RemoteEventStream";
import { mapAgentPatchToRemoteEvent } from "../src/main/remote/RemoteEventBus";
import type { DurableBotSnapshot } from "../src/shared/durable-bot";

const first: DurableBotSnapshot = { backend: "pi-durable", epoch: "epoch-one", revision: 1, conversationId: "1", toolMode: "native", busy: true, queued: 0, pendingInputs: [], compacting: false,
  messages: [{ id: "old", role: "user", text: "old history", createdAt: 1, attachments: [{ name: "safe.txt", path: "C:/private/file.txt" }] }, { id: "live", role: "assistant", text: "one", createdAt: 2 }] };
const snapshot = (revision: number): DurableBotSnapshot => ({ ...first, revision, messages: [first.messages[0], { ...first.messages[1], text: String(revision) }] });
const update = (base: DurableBotSnapshot, next: DurableBotSnapshot) => {
  const { epoch: _epoch, revision: _revision, messages: _messages, ...state } = next;
  return durableDelta(base, next, state);
};
const delta = update(first, snapshot(2));
assert.equal(delta.upserts.length, 1);
assert.equal(delta.order, undefined);
assert(!JSON.stringify(delta).includes("old history"), "token events never carry an unchanged historical message");
const applied = applyDurableDelta(first, delta);
assert.equal(applied.kind, "applied");
if (applied.kind === "applied") {
  assert.deepEqual(applied.snapshot, snapshot(2));
  assert.equal(applied.snapshot.messages[0], first.messages[0]);
}
assert.equal(applyDurableDelta(first, update(snapshot(2), snapshot(3))).kind, "resync");
assert.equal(applyDurableDelta(snapshot(3), delta).kind, "stale");
assert.equal(applyDurableDelta({ ...first, epoch: "other" }, delta).kind, "resync");
const page: DurableBotSnapshot = { ...snapshot(2), revision: 3, messages: [{ id: "earlier", role: "user", text: "earlier page", createdAt: 0 }, ...snapshot(2).messages] };
const pageDelta = update(snapshot(2), page);
assert.deepEqual(pageDelta.order, ["earlier", "old", "live"]);
assert.equal(pageDelta.upserts[0].id, "earlier");
const deletion = { ...page, revision: 4, messages: [page.messages[0], page.messages[2]] };
const deletionResult = applyDurableDelta(page, update(page, deletion));
assert(deletionResult.kind === "applied"); assert.deepEqual(deletionResult.snapshot.messages, deletion.messages);
const mapped = mapAgentPatchToRemoteEvent({ type: "durable_delta", taskId: "task", delta: pageDelta });
assert(!JSON.stringify(mapped).includes("C:/private"), "remote delta upserts use the existing field projection");

const realFetch = globalThis.fetch;
const restarted = { ...snapshot(1), epoch: "epoch-two" };
const restartedNext = { ...snapshot(2), epoch: "epoch-two" };
assert.deepEqual(replayDurableDeltas(restarted, [delta, update(restarted, restartedNext)]), { snapshot: restartedNext, gap: false });
assert.equal(replayDurableDeltas(restarted, [update({ ...restarted, revision: 3 }, { ...restarted, revision: 4 })]).gap, true);
let reads = 0, releaseHistory!: () => void;
const blockedHistory = new Promise<void>(resolve => { releaseHistory = resolve; });
const client = new RemoteClient("http://durable-sync-fixture", "token");
const interaction = { id: "question", taskId: "task", executionId: "execution", assistantMessageId: "live", kind: "confirm" as const, title: "Continue?", options: [], status: "pending" as const, version: 1, createdAt: 2 };
globalThis.fetch = async input => {
  if (String(input).endsWith("/history")) { reads++; await blockedHistory; return Response.json({ taskId: "task", messages: snapshot(4).messages, durable: snapshot(4) }); }
  return Response.json({ taskId: "task", busy: true, interactions: [interaction], pendingActions: [], activeGoal: null });
};
let eventId = 0;
const emit = (payload: unknown) => applyEvent({ apiVersion: REMOTE_API_VERSION, id: ++eventId, at: Date.now(), type: "agent.patch", payload });
try {
  useRemoteStore.setState({ client, histories: {}, live: {}, runtimes: { task: { taskId: "task", busy: true, pendingActions: [], interactions: [interaction], activeGoal: null } } });
  emit(mapAgentPatchToRemoteEvent({ type: "durable_snapshot", taskId: "task", snapshot: first }));
  emit(mapAgentPatchToRemoteEvent({ type: "durable_delta", taskId: "task", delta }));
  assert.equal(useRemoteStore.getState().histories.task.durable?.revision, 2);
  assert.deepEqual(useRemoteStore.getState().runtimes.task.interactions, [interaction], "stream updates preserve remote interaction cards");
  emit(mapAgentPatchToRemoteEvent({ type: "durable_delta", taskId: "task", delta: update(snapshot(3), snapshot(4)) }));
  emit(mapAgentPatchToRemoteEvent({ type: "durable_delta", taskId: "task", delta: update(snapshot(4), snapshot(5)) }));
  assert.equal(reads, 1);
  releaseHistory();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(useRemoteStore.getState().histories.task.durable?.revision, 5);
  emit(mapAgentPatchToRemoteEvent({ type: "durable_delta", taskId: "task", delta }));
  assert.equal(reads, 1);
  globalThis.fetch = async input => {
    if (String(input).endsWith("/history")) { reads++; return Response.json({ taskId: "task", messages: restarted.messages, durable: restarted }); }
    return Response.json({ taskId: "task", busy: true, interactions: [], pendingActions: [], activeGoal: null });
  };
  emit(mapAgentPatchToRemoteEvent({ type: "durable_delta", taskId: "task", delta: update(snapshot(7), snapshot(8)) }));
  emit(mapAgentPatchToRemoteEvent({ type: "durable_delta", taskId: "task", delta: update(restarted, restartedNext) }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 2, "a new-epoch snapshot discards the old-epoch trigger without another history read");
  assert.equal(useRemoteStore.getState().histories.task.durable?.epoch, "epoch-two");
  assert.equal(useRemoteStore.getState().histories.task.durable?.revision, 2);
} finally { globalThis.fetch = realFetch; useRemoteStore.setState({ client: null }); }

// The host accepts the first POST but the client loses its response and resets UI overrides.
const posted: Array<Record<string, unknown>> = [];
globalThis.fetch = async (_url, options) => {
  posted.push(JSON.parse(String(options?.body)));
  if (posted.length === 1) throw new Error("response lost after admission");
  return Response.json({ receipt: { operationId: posted.at(-1)?.operationId } });
};
try {
  const original = { text: "retry draft", modelId: "fixture/selected", permissionMode: "auto" as const };
  await assert.rejects(client.prompt("retry-task", original), /response lost/);
  await new RemoteClient("http://durable-sync-fixture", "token").prompt("retry-task", { text: original.text });
  assert.deepEqual(posted[1], posted[0], "reconnect reuses both the operation ID and the original request body");
  await client.prompt("retry-task", { text: original.text });
  assert.notEqual(posted[2].operationId, posted[0].operationId, "an acknowledged draft can be submitted as a new operation");
} finally { globalThis.fetch = realFetch; }

const streamEvents: RemoteEventEnvelope[] = [];
class StreamClient extends RemoteClient {
  override async eventStream(_last: number, signal: AbortSignal, onEvent: (event: RemoteEventEnvelope) => void, onOpen?: () => void): Promise<void> {
    onOpen?.();
    for (const id of [1, 3]) onEvent({ apiVersion: REMOTE_API_VERSION, id, at: id, type: "task.changed", payload: {} });
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}
const stream = new RemoteEventStream(new StreamClient("http://fixture", "token"), event => streamEvents.push(event), () => {});
stream.start(); await new Promise<void>(resolve => setImmediate(resolve)); stream.stop();
assert(streamEvents.some(event => event.type === "resync_required"), "a missing SSE event requests a full sync instead of silently advancing its cursor");
console.log("PASS Durable delta protocol, pagination/removal, epoch/revision checks, desktop-safe row reuse, remote privacy, interaction retention, single-flight gap repair and SSE gaps");
