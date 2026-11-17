import assert from "node:assert/strict";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { BrowserHandoff, type BrowserHandoffIdentity } from "../src/main/capabilities/browser/BrowserHandoff";

const db = new AppDatabase(":memory:");
db.upsertTask({ id: "task-a", title: "Browser handoff", updatedAt: Date.now() });
const patches: unknown[] = [];
const interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), patch => patches.push(patch));
const handoffs = new BrowserHandoff();
const context = { taskId: "task-a", executionId: "execution-a", assistantMessageId: "message-a" };
let live: BrowserHandoffIdentity = { taskId: "task-a", ownerId: "task-a", tabId: "tab-a", webContentsId: 37, documentId: "login-document" };
const inspectTab = () => ({ ...live });
const ask = (request: Parameters<typeof interactions.requestDurable>[1], key: string, signal?: AbortSignal) =>
  interactions.requestDurable(context, request, { key, signal });

try {
  const pending = handoffs.begin({ identity: { ...live }, requestKey: "call-a", reason: "2fa", ask, inspectTab });
  await new Promise(resolve => setTimeout(resolve, 0));
  const first = interactions.listByTask("task-a")[0];
  assert(first && first.status === "pending" && first.kind === "confirm");
  assert.equal(patches.length, 1, "real interaction service publishes the question");
  assert.equal(interactions.respond(first.id, true).ok, true);
  live = { ...live, documentId: "account-document" };
  const issued = await pending;
  assert(issued.token && issued.initialDocumentId === "login-document");
  await assert.rejects(handoffs.resume({ token: "invented", identity: live, inspectTab,
    verify: async () => ({ passed: true, documentId: live.documentId, evidence: "fake" }) }), /stale/);
  await assert.rejects(handoffs.resume({ token: issued.token, identity: { ...live, taskId: "task-b" }, inspectTab,
    verify: async () => ({ passed: true, documentId: live.documentId, evidence: "wrong task" }) }), /another task/);
  const unverified = await handoffs.resume({ token: issued.token, identity: live, inspectTab,
    verify: async () => ({ passed: false, documentId: live.documentId, evidence: "account absent" }) });
  assert.deepEqual(unverified, { status: "pending", evidence: "account absent", documentId: "account-document" });
  const verified = await handoffs.resume({ token: issued.token, identity: live, inspectTab,
    verify: async () => ({ passed: true, documentId: live.documentId, evidence: "account visible" }) });
  assert.equal(verified.status, "confirmed");
  await assert.rejects(handoffs.resume({ token: issued.token, identity: live, inspectTab,
    verify: async () => ({ passed: true, documentId: live.documentId, evidence: "replayed" }) }), /already used/);

  const canceled = handoffs.begin({ identity: { ...live }, requestKey: "call-cancel", reason: "login", ask, inspectTab });
  await new Promise(resolve => setTimeout(resolve, 0));
  const cancelQuestion = interactions.listByTask("task-a").find(item => item.status === "pending");
  assert(cancelQuestion);
  assert.equal(interactions.cancel(cancelQuestion.id).ok, true);
  await assert.rejects(canceled);

  const declined = handoffs.begin({ identity: { ...live }, requestKey: "call-decline", reason: "login", ask, inspectTab });
  await new Promise(resolve => setTimeout(resolve, 0));
  const declineQuestion = interactions.listByTask("task-a").find(item => item.status === "pending");
  assert(declineQuestion);
  assert.equal(interactions.respond(declineQuestion.id, false).ok, true);
  await assert.rejects(declined, /did not complete/);

  const moved = handoffs.begin({ identity: { ...live }, requestKey: "call-move", reason: "login", ask, inspectTab });
  await new Promise(resolve => setTimeout(resolve, 0));
  const moveQuestion = interactions.listByTask("task-a").find(item => item.status === "pending");
  assert(moveQuestion);
  live = { ...live, webContentsId: 38 };
  assert.equal(interactions.respond(moveQuestion.id, true).ok, true);
  await assert.rejects(moved, /tab changed/);

  console.log("PASS real persisted user question, answer, cancel, same-tab identity and one-shot verified resume");
} finally {
  db.close();
}
