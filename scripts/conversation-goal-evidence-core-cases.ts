import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GenerationTask, ROOT_CONVERSATION_ID, type DocumentId, type EntryId, type StorageWrite, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import type { AgentService } from "../src/main/agent/AgentService";
import { DURABLE_ARTIFACT_ENTRY_KIND } from "../src/main/agent/durable/DurableArtifactReceipt";
import { inspectDurableArtifact } from "../src/main/agent/durable/DurableArtifactRegistration";
import { DuckDbStorage, resolveStoreId } from "../src/main/agent/durable/DuckDbStorage";
import { SavedArtifactActions } from "../src/main/artifact/SavedArtifactActions";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import type { RuntimeAuditReader } from "../src/main/platform/runtime-audit";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import type { GoalNativeEvidence } from "../src/shared/conversation-goal-activity";

type ArtifactFixture = { name: string; text: string };

async function saveNativeEvidence(
  reader: RuntimeAuditReader, root: string, taskId: string, cwd: string, workId: string,
  versions: { expectedIntentRevision: number; expectedOwnerEpoch: number }, output: ArtifactFixture[],
): Promise<void> {
  const directory = join(root, "durable", createHash("sha256").update(taskId).digest("hex"));
  mkdirSync(directory, { recursive: true });
  assert.equal((await reader.writeDurableTaskProjection({ kind: "bindBot", taskId, directory, cwd }))?.status, "applied");
  const storage = await DuckDbStorage.openWriter(reader, await resolveStoreId(reader, directory));
  try {
    const conversationId = ROOT_CONVERSATION_ID;
    const userEntryId = await storage.mintId<EntryId>();
    const inputId = await storage.mintId<SubmissionId>();
    const generationId = await storage.mintId<TaskId<JsonValue>>();
    const documentId = await storage.mintId<DocumentId>();
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: conversationId } },
      { type: "entry", value: { id: userEntryId, conversationId, kind: "mybuddy.user" } },
      { type: "submission", value: { id: inputId, conversationId, requestId: `fixture-${taskId}`, type: "input", status: "placed", entry: userEntryId } },
      { type: "task", value: { id: generationId, conversationId, kind: GenerationTask.definition.name,
        input: {}, version: GenerationTask.definition.version, background: false, abortRequested: false, state: { status: "pending", checkpoint: {} } } },
    ];
    const events: Array<{ toolTaskId: number; evidence: Extract<GoalNativeEvidence, { kind: "delivery" }> }> = [];
    for (const item of output) {
      const path = join(cwd, item.name);
      writeFileSync(path, item.text, "utf8");
      const saved = await inspectDurableArtifact(cwd, path, directory);
      assert(saved.snapshotPath);
      const registeredAt = Date.now();
      const toolTaskId = await storage.mintId<TaskId<JsonValue>>();
      const entryId = await storage.mintId<EntryId>();
      writes.push({ type: "task", value: { id: toolTaskId, conversationId, owner: generationId, kind: "fixture-goal-artifact-tool",
        input: {}, version: 1, background: false, abortRequested: false, state: { status: "pending", checkpoint: {} } } });
      writes.push({ type: "entry", value: { id: entryId, conversationId, byTaskId: toolTaskId, kind: DURABLE_ARTIFACT_ENTRY_KIND,
        data: { ...saved, snapshotPath: saved.snapshotPath, registeredAt, toolTaskId,
          toolCallId: `fixture-${entryId}`, toolConversationId: conversationId, inputIds: [inputId] } } });
      events.push({ toolTaskId, evidence: { kind: "delivery", path: saved.path, digest: saved.digest,
        saved: { snapshotPath: saved.snapshotPath, registeredAt } } });
    }
    writes.push({ type: "document.create", record: { id: documentId, kind: "mybuddy.pstack-goal-evidence",
      scope: { kind: "session" }, key: JSON.stringify([String(conversationId), generationId]) },
      content: { kind: "base", version: 1, value: { events } } });
    const saved = await storage.commit([writes], () => undefined, BACKGROUND_CONTEXT);
    assert.equal(saved.stored, 1, String(saved.refused ?? ""));
    assert.deepEqual(await reader.batch1Write({ kind: "goalActivityAdmit", userId: LOCAL_USER_ID, taskId,
      conversationId: String(conversationId), generationId, workId,
      metadataJson: JSON.stringify({ intentRevision: versions.expectedIntentRevision, ownerEpoch: versions.expectedOwnerEpoch, assistantMessageIds: [] }),
    }), { ok: true, admitted: true });
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

export async function verifyConversationGoalEvidence(db: AppDatabase, agent: AgentService, background: RuntimeAuditReader, root: string): Promise<void> {
  const reader = db.runtimeAuditReader;
  assert(reader && db.coreIdentity);
  assert.equal(db.fixtureConnection, undefined);
  const tasks = { home: "goal-evidence-home", teammate: "goal-evidence-same", foreign: "goal-evidence-other", unlinked: "goal-evidence-unlinked" };
  const spaces = { home: "goal-evidence-workspace-a", foreign: "goal-evidence-workspace-b" };
  const homePath = join(root, spaces.home);
  const foreignPath = join(root, spaces.foreign);
  mkdirSync(homePath);
  mkdirSync(foreignPath);
  await db.writeWorkspaceUpsert({ id: spaces.home, name: "Evidence workspace A", path: homePath });
  await db.writeWorkspaceUpsert({ id: spaces.foreign, name: "Evidence workspace B", path: foreignPath });
  const at = Date.now();
  for (const taskId of Object.values(tasks)) {
    const inForeignWorkspace = taskId === tasks.foreign;
    await db.writeTaskRecord({ id: taskId, title: taskId, spaceId: inForeignWorkspace ? spaces.foreign : spaces.home,
      cwd: inForeignWorkspace ? foreignPath : homePath, updatedAt: at });
  }
  const made = await agent.createSavedConversationGoal({ taskId: tasks.home, title: "Evidence from a shared Goal" });
  assert(made.ok);
  const workId = made.goal.id;
  const current = await agent.readLiveConversationGoalForTool(tasks.home, workId);
  assert(current?.versionGuard);
  const versions = current.versionGuard;
  for (const conversationId of [tasks.teammate, tasks.foreign]) {
    assert.deepEqual(await background.batch4bWrite({ op: "workConversationLink", workId, conversationId,
      channelType: "desktop", lastReferencedAt: at }), { ok: true });
  }
  const report = { name: "verified-report.txt", text: "Immutable snapshot contents\n" };
  const changing = { name: "revision-race.txt", text: "Review against original Goal revision\n" };
  const teammate = { name: "same-workspace.txt", text: "Shared workspace contribution\n" };
  const foreign = { name: "another-workspace.txt", text: "Scoped away from the owner workspace\n" };
  await saveNativeEvidence(reader, root, tasks.home, homePath, workId, versions, [report, changing]);
  await saveNativeEvidence(background, root, tasks.teammate, homePath, workId, versions, [teammate]);
  await saveNativeEvidence(background, root, tasks.foreign, foreignPath, workId, versions, [foreign]);

  assert.equal(await reader.readConversationGoalEvidence(tasks.home, "unrelated-user", workId), null);
  assert.equal(await agent.getConversationGoalEvidence(tasks.unlinked, workId), undefined);
  const [homeResult, foreignResult] = await Promise.all([
    agent.getConversationGoalEvidence(tasks.home, workId), agent.getConversationGoalEvidence(tasks.foreign, workId),
  ]);
  assert(homeResult?.activity && foreignResult?.activity);
  assert.deepEqual(new Set(homeResult.activity.runs.map(row => row.taskId)), new Set([tasks.home, tasks.teammate]));
  assert.deepEqual(new Set(homeResult.savedArtifacts.map(item => basename(item.path))), new Set([report.name, changing.name, teammate.name]));
  assert.deepEqual(foreignResult.savedArtifacts.map(item => basename(item.path)), [foreign.name]);

  const confirmedReport = homeResult.savedArtifacts.find(item => basename(item.path) === report.name);
  const changedReport = homeResult.savedArtifacts.find(item => basename(item.path) === changing.name);
  const movedReport = homeResult.savedArtifacts.find(item => basename(item.path) === teammate.name);
  assert(confirmedReport && changedReport && movedReport);
  assert.equal(confirmedReport.verification, undefined);
  writeFileSync(confirmedReport.path, "The working file has since changed\n", "utf8");
  const actions = new SavedArtifactActions({ storageRoot: root, exportRoot: join(root, "goal-evidence-export"),
    chooseDestination: async () => undefined, openPath: async () => assert.fail("Test must not open another application") });
  assert.equal(await agent.readGoalArtifactText(tasks.home, workId, confirmedReport.id, request => actions.readText(request)), report.text);
  assert.equal(await agent.readGoalArtifactText(tasks.foreign, workId, confirmedReport.id,
    async () => assert.fail("The other workspace cannot open the owner's snapshot")), undefined);
  assert.equal(await agent.verifyGoalArtifact(tasks.foreign, workId, confirmedReport.id,
    async () => assert.fail("The other workspace cannot verify the owner's snapshot")), undefined);
  const verified = await Promise.all([tasks.home, tasks.teammate].map(taskId =>
    agent.verifyGoalArtifact(taskId, workId, confirmedReport.id, request => actions.verifiedSnapshot(request))));
  assert.equal(verified[0]?.verification?.kind, "user");
  assert.deepEqual(verified[0]?.verification, verified[1]?.verification);

  const moved = await agent.verifyGoalArtifact(tasks.home, workId, movedReport.id, async request => {
    await actions.verifiedSnapshot(request);
    assert.equal((await background.upsertTaskRecord({ id: tasks.teammate, title: tasks.teammate, spaceId: spaces.foreign,
      cwd: foreignPath, at: Date.now(), preserveTitle: false, preserveWorkspace: false }))?.status, "saved");
    assert.equal((await db.readTask(tasks.teammate, { includeExpertBinding: false }))?.spaceId, spaces.foreign);
  });
  assert.equal(moved, undefined, "Moving the source workspace wins against a stale verification");
  assert.equal(await agent.readGoalArtifactText(tasks.home, workId, movedReport.id,
    async () => assert.fail("The moved source snapshot cannot be opened")), undefined);

  const changed = await agent.verifyGoalArtifact(tasks.home, workId, changedReport.id, async request => {
    await actions.verifiedSnapshot(request);
    const text = await agent.readGoalArtifactText(tasks.home, workId, changedReport.id, async requestDuringEdit => {
      const savedText = await actions.readText(requestDuringEdit);
      const reply = await background.workScheduler({ action: "amendWork", operationId: "evidence-concurrent-amend", userId: LOCAL_USER_ID,
        workId, title: "Revised evidence Goal", ...versions });
      assert.equal(reply?.ok, true, JSON.stringify(reply));
      return savedText;
    });
    assert.equal(text, undefined, "A preview read held across an edit cannot return the stale result");
  });
  assert.equal(changed, undefined, "An edit committed during verification invalidates its old receipt");
  const final = await reader.readConversationGoalEvidence(tasks.home, LOCAL_USER_ID, workId);
  assert.equal(final?.evidence.intentRevision, versions.expectedIntentRevision + 1);
  assert.deepEqual(final?.savedArtifactVerifications, [{ artifactId: confirmedReport.id, verifiedAt: verified[0]?.verification?.verifiedAt }]);
  console.log("PASS Goal evidence opens exact native artifact bytes, respects linked workspace scope, and rejects verification after an edit or source move");
}
