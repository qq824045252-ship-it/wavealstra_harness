import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
const root = await mkdtemp(join(tmpdir(), "work-automatic-recovery-"));
const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } };
const unwrap = (r: WorkControlResult) => { if (!r.ok) throw Error(r.message); return r.work; };
async function run(name: string, final: "completed" | "failed" | "stopped", unknown = false) {
  const path = join(root, name + ".db"); let db = new AppDatabase(path);
  let bots = new BotRegistry(db.connection); bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "fixture", authorization: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } });
  let works = new WorkService(db.connection, { bots });
  const work = unwrap(works.createWork(actor, { operationId: name, title: "查询天气", inputSnapshotId: name,
    mode: name === "watch" ? "watch" : "once", authorization: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } }));
  const stages = new Map<string, number>();
  let permissionMode: "readonly" | "auto" = name === "readonly" ? "readonly" : "auto";
  const receipts = new Map<string, AgentSubmissionReceipt>(), inputs: string[] = [], errors: unknown[] = [];
  const artifact = join(root, name + ".md"); let writes = 0;
  const native: WorkExecutionPort = {
    prepare: async taskId => ({ taskId, durableStoreKey: taskId, conversationId: "1", workspaceBinding: root }),
    find: async binding => receipts.get(binding.bindingId),
    submit: async (binding, text) => {
      stages.set(binding.bindingId, inputs.length); inputs.push(text);
      const input = z.object({ recovery: z.object({
        retainedResults: z.array(z.object({ artifacts: z.array(z.string()) })),
        completed: z.array(z.object({ artifactRefs: z.array(z.string()) })),
      }).optional() }).parse(JSON.parse(text));
      if (!input.recovery) { writes++; await writeFile(artifact, "杭州：已有真实任务结果\n"); }
      else {
        const retainedPath = [...input.recovery.retainedResults.flatMap(result => result.artifacts),
          ...input.recovery.completed.flatMap(item => item.artifactRefs)].find(path => path === artifact);
        assert(retainedPath, "every recovery retains ancestral artifact path");
        assert.equal(await readFile(retainedPath, "utf8"), "杭州：已有真实任务结果\n");
        if (name === "ancestry") assert(text.includes("original-source-weather-payload"), "later recovery keeps original trigger payload");
        if (unknown || name === "readonly") {
          const denied = works.admitTaskAction(binding.taskId, { operationId: `write:${binding.bindingId}`, actionKind: "workspace:write" });
          if (name === "readonly") assert.equal(denied, undefined, "retired readonly permission does not block recovery actions");
          else {
            assert.equal(denied, undefined, "unknown history does not prevent authorized independent work");
            await writeFile(join(root, `${name}-independent.txt`), "independent recovery output");
            works.settleTaskAction(binding.taskId, `write:${binding.bindingId}`, "consumed");
          }
          assert.equal(works.admitTaskAction(binding.taskId, { operationId: `read:${binding.bindingId}`, actionKind: "workspace:read" }), undefined);
          works.settleTaskAction(binding.taskId, `read:${binding.bindingId}`, "consumed");
        }
      }
      const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" };
      receipts.set(binding.bindingId, receipt); return receipt;
    },
    inspect: async binding => {
      const continuation = !!works.partialResults.executionInput(binding);
      if (continuation) {
        assert.equal(db.getTask(binding.taskId)?.spaceId,"bot-test-space", "recovery stays in the original Bot workspace");
        assert.equal(db.getTask(binding.taskId)?.modelId,"original-bot-model", "recovery keeps the original Bot model");
      }
      const stage = stages.get(binding.bindingId) ?? 0;
      const staged = ["ancestry", "successful-readback", "gap-chain"].includes(name);
      const status = !continuation ? final === "stopped" ? "stopped" : "failed" : staged && stage === 1 ? "failed" : final;
      const items = ["gaps", "gap-chain", "duplicate-progress"].includes(name)
        ? [...(name === "gap-chain" && stage === 1 ? [] : [{ itemId: `read-${binding.bindingId}`, task: "read existing evidence", required: true,
          dependencies: [], criterionIds: [], nativeStatus: "completed", outcome: "completed" as const, artifactRefs: [artifact], writeConflicts: [], summary: "same evidence" }]),
          ...(name === "gap-chain" && stage === 1 ? [] : [{ itemId: "missing-step", task: "retrieve missing weather fact", required: true, dependencies: [], criterionIds: [],
            nativeStatus: status, outcome: status === "completed" ? "completed" as const : "failed" as const, artifactRefs: [], writeConflicts: [], summary: "weather fact" }])]
        : [];
      return { status, summary: status === "completed" ? "已读取现有报告并给出天气答案" : "",
        failureReason: status === "failed" ? "parser unavailable" : undefined,
        artifactRefs: staged && stage === 1 ? [] : [artifact], hasWriteConflicts: false, subitems: items };
    }, stop: async () => {},
  };
  const create = () => {
    const adapter = new WorkExecutionAdapter(works, native, LOCAL_USER_ID, () => true, (_id, e) => errors.push(e));
    const queue = new WorkDispatchQueue(db, works, adapter, () => true, () => "fixture", () => permissionMode); return { adapter, queue };
  };
  let { adapter, queue } = create();
  works.transaction(() => queue.enqueue(work, name));
  const originalTaskId = (db.connection.prepare("SELECT task_id FROM work_dispatch_requests WHERE operation_id=?").get(name) as {task_id: string}).task_id;
  db.upsertSpace({id:"bot-test-space",name:"Bot workspace"});
  db.upsertTask({...db.getTask(originalTaskId)!,spaceId:"bot-test-space",modelId:"original-bot-model"});
  if (name === "legacy-quota") {
    db.connection.prepare("UPDATE work_dispatch_requests SET state='blocked',attempts=3,error='budget_exhausted: old exhausted window' WHERE operation_id=?").run(name);
    works.repo.insertBlocker({ blockerId: `dispatch:${name}`, workId: work.workId, kind: "operational",
      reason: "legacy quota dispatch refusal", waitingForUserInput: false, status: "open", createdAt: Date.now() });
  }
  await queue.flush();
  if (name === "ancestry") works.transaction(() => {
    works.repo.insertInbox({ eventId: "original-event", dedupeKey: "original-event", source: "test", sourceEventId: "source", eventType: "test", workId: work.workId,
      intentRevision: work.intentRevision, stateVersion: work.stateVersion, ownerEpoch: work.ownerEpoch, status: "processed", payload: { request: "original-source-weather-payload" }, mergedCount: 0, receivedAt: Date.now() });
    const original = works.repo.listBindings(work.workId)[0]!;
    works.repo.updateBinding({ ...original, inboxEventId: "original-event" });
  });
  if (unknown) works.transaction(() => works.repo.insertBlocker({ blockerId: "unknown", workId: work.workId, kind: "external_effect", reason: "receipt lost", waitingForUserInput: false, status: "open", createdAt: Date.now() }));
  permissionMode = "auto"; // A later application default cannot widen the source task's readonly mode.
  if (name === "handoff") {
    const original = works.repo.listBindings(work.workId)[0]!;
    works.repo.updateBinding({ ...original, delegatedScope: ["workspace:read"] }); // Retired owner scope did not restrict its auto task.
    bots.registerBot({ botId: "next-owner", userId: LOCAL_USER_ID, displayName: "next", authorization: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } });
    unwrap(works.handoffOwner({ kind: "user", userId: LOCAL_USER_ID, grants: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } },
      { operationId: "handoff-owner", workId: work.workId, targetBotId: "next-owner" }));
  }
  // Recovery is durable before submission; reopening must resume the same plan.
  await queue.close(); await adapter.close(); db.close();
  db = new AppDatabase(path); bots = new BotRegistry(db.connection); works = new WorkService(db.connection, { bots });
  ({ adapter, queue } = create());
  try {
    for (let i = 0; i < 8; i++) {
      await queue.flush();
      for (const id of works.automaticCompletion.pending()) if (works.transaction(() => works.automaticCompletion.outcome(id)))
        works.automaticCompletion.recordDelivery(id,"fixture report delivered");
      works.automaticCompletion.drain();
    }
    assert.deepEqual(errors, []);
    assert.equal(writes, 1, "continuation must never replay completed file write");
    if (name === "legacy-quota") assert.equal(works.repo.getBlocker(`dispatch:${name}`)?.status, "cleared", "same-identity successful dispatch resolves its own historical quota refusal");
    assert(!works.repo.listBlockers(work.workId).some(b => b.waitingForUserInput), "runtime failure is not a user decision");
    if (final === "stopped") assert.equal(inputs.length, 1, "user stop is not retried");
    else if (["ancestry", "successful-readback", "gap-chain"].includes(name)) {
      assert.equal(inputs.length, 3); assert.equal(works.getWork(work.workId)?.closureConclusion, "ended_unsuccessfully");
      if (name === "gap-chain") assert(!works.partialResults.gaps(work.workId).some(item => item.itemId === "missing-step"), "real descendant evidence resolves original failed subitem across absent intermediate facts");
    } else if (final === "completed") {
      assert.equal(inputs.length, 2); assert.equal(works.partialResults.gaps(work.workId).length, 0);
      assert.equal(works.repo.listDeliverables(work.workId).filter(item => item.summary === "已读取现有报告并给出天气答案").length, 1, "synthetic root gap must not duplicate recovered answer");
    } else {
      assert.equal(inputs.length, 3, "identical completed facts are not new progress");
      assert(works.repo.listBlockers(work.workId).some(b => b.blockerId.startsWith("recovery-ended:")));
      if (name === "watch") assert.equal(works.getWork(work.workId)?.lifecycle, "active", "one unsuccessful round must not terminate persistent watch");
      else assert.equal(works.getWork(work.workId)?.closureConclusion, "ended_unsuccessfully");
    }
    const recoveryRequests = db.connection.prepare("SELECT task_id FROM work_dispatch_requests WHERE continuation_plan_id IS NOT NULL").all() as { task_id: string }[];
    if (name === "readonly") assert(recoveryRequests.every(r => db.getTask(r.task_id)?.permissionMode === "auto"));
    if (unknown) {
      assert.equal(await readFile(join(root, `${name}-independent.txt`), "utf8"), "independent recovery output");
      assert(recoveryRequests.every(r => db.getTask(r.task_id)?.permissionMode === "auto"));
      assert.equal(works.repo.getBlocker("unknown")?.details?.effectDisposition, "continue_without_replay");
    }
    if (name === "handoff") assert(recoveryRequests.every(r => db.getTask(r.task_id)?.permissionMode === "auto"), "handoff does not turn former owner into restricted member");
  } finally { await queue.close(); await adapter.close(); db.close(); }
}
try {
  await run("retained-report", "completed");
  await run("legacy-quota", "completed");
  await run("stopped", "stopped");
  await run("gaps", "completed");
  await run("gap-chain", "completed");
  await run("ancestry", "completed");
  await run("successful-readback", "completed");
  await run("duplicate-progress", "failed");
  await run("readonly", "completed");
  await run("handoff", "completed");
  await run("watch", "failed");
  await run("no-progress", "failed");
  await run("unknown-effect", "completed", true);
  console.log("PASS automatic recovery: root task, original output, restart dedupe, stop, no progress and nonblocking unknown-effect evidence");
} finally { await rm(root, { recursive: true, force: true }); }
