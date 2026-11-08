/** Native runtime + SQLite + real filesystem regression. The scripted provider is
 * deliberately a fixture, NOT live-provider or desktop/UI acceptance evidence. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, access, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, createWriteTool } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";
import type { WorkActionApprovalDto } from "../src/shared/bot-work-approval";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { resolveWorkContinuationCwd } from "../src/main/agent/work/WorkContinuationWorkspace";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { workShellRead } from "../src/main/agent/work/WorkShellRead";
import type { PermissionMode } from "../src/shared/agent-ipc";
import { WorkToolResourcePolicy } from "../src/main/agent/work/WorkToolResourcePolicy";

const root = await mkdtemp(join(tmpdir(), "mybuddy-work-approval-native-"));
const hostileBin = join(root, "hostile-bin"), shellMarker = join(root, "shell-startup-ran"), pathMarker = join(root, "path-command-ran");
await mkdir(hostileBin);
const bashEnv = join(root, "hostile-bash-env");
await writeFile(bashEnv, `printf triggered >> '${shellMarker}'\n`);
for (const command of ["ls", "cat"]) {
  const file = join(hostileBin, command);
  await writeFile(file, `#!/bin/sh\nprintf triggered >> '${pathMarker}'\nexit 81\n`); await chmod(file, 0o755);
}
const originalPath = process.env.PATH, originalBashEnv = process.env.BASH_ENV;
process.env.PATH = `${hostileBin}${delimiter}${originalPath ?? ""}`;
process.env.BASH_ENV = bashEnv;
const db = new AppDatabase(join(root, "app.db"));
const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const attempts = new ExecutionAttemptRepository(db.connection);
const failures = new ExecutionFailureRepository(db.connection);
const interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {});
const call = (name: string, args: import("@earendil-works/pi-durable").JsonObject, id: string): AssistantMessage["content"] => [{ type: "toolCall", id, name, arguments: args }];
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
async function until(check: () => boolean) {
  const end = Date.now() + 15_000;
  while (!check()) { if (Date.now() > end) throw new Error("Native fixture did not reach expected state"); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture(taskId: string, withoutWorkPath = false) {
  const cwd = join(root, taskId); await mkdir(cwd);
  db.upsertTask({ id: taskId, title: taskId, updatedAt: Date.now() });
  let now = Date.now();
  let permissionMode: PermissionMode = "auto";
  let works = new WorkService(db.connection, { bots, now: () => now });
  const created = works.createWork(user, { operationId: `${taskId}:create`, title: taskId, workspacePath: withoutWorkPath ? undefined : cwd,
    inputSnapshotId: `${taskId}:input`, authorization: { ...DESKTOP_USER_GRANTS, allowedScopes: ["workspace:read"] } });
  assert(created.ok);
  const dispatched = works.dispatchExecution(user, { workId: created.work.workId, operationId: `${taskId}:dispatch`, botId: DEFAULT_BOT_ID,
    taskId, durableStoreKey: `store:${taskId}`, conversationId: "1", workspaceBinding: cwd, delegatedScope: ["workspace:read"] });
  assert(dispatched.ok);
  const binding = works.repo.bindingForTask(taskId)!;
  const observed: Array<{ name: string; error: boolean; body: string }> = [];
  const respond = (request: TranscriptContext): AssistantMessage["content"] => {
    const last = request.messages.at(-1);
    if (last?.role !== "toolResult") return call("bash", { command: "pwd" }, "pwd");
    observed.push({ name: last.toolName, error: !!last.isError, body: JSON.stringify(last.content) });
    if (last.isError) return text("Blocked; retain completed work and await a new authorized step.");
    if (last.toolCallId === "pwd") return call("write", { path: "proof.txt", content: "native proof\n" }, "write-proof");
    if (last.toolCallId === "write-proof") return call("bash", { command: "ls" }, "ls");
    if (last.toolCallId === "ls") return call("bash", { command: "cat proof.txt" }, "cat-proof");
    if (last.toolCallId === "cat-proof") return call("read", { path: "proof.txt" }, "read-proof");
    return text("Read back native proof. Await independent acceptance.");
  };
  const models = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "catalog.json"), refreshOnCreate: false });
  models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "Scripted native regression fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, request) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = respond(request), stopReason = content.some(c => c.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, provider: model.provider,
          model: model.id, timestamp: Date.now(), usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      }); return stream;
    },
  });
  const open = async () => {
    const policy = createDurableToolPolicy({ taskId, taskRoot: cwd, getPermissionMode: () => permissionMode, interactions, attempts, failures,
      approveWorkAction: (input, signal) => works.approvals.request(input, signal),
      admitWorkAction: input => works.admitTaskAction(taskId, input),
      settleWorkAction: (id, outcome) => works.settleTaskAction(taskId, id, outcome),
      resourcePolicy: new WorkToolResourcePolicy(works.resourceGate, () => ({ taskId, workId: binding.workId, bindingId: binding.bindingId,
        durableStoreKey: binding.durableStoreKey, conversationId: binding.conversationId, workspaceBinding: binding.workspaceBinding })),
    });
    return DurableBotRuntime.open({ taskId, cwd, directory: join(cwd, "state"), models, model: { provider: "fixture", modelId: "model" },
      toolMode: "native", toolHooks: policy.hooks, instructions: () => "scripted regression fixture", onSnapshot: () => {} });
  };
  const pending = () => works.approvals.list(binding.workId).find(a => a.status === "pending");
  const decision = (a: WorkActionApprovalDto, approved = true) => {
    const work = works.getWork(binding.workId)!;
    return { approvalId: a.approvalId, workId: a.workId, bindingId: a.bindingId, expectedVersion: a.version,
      expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch,
      approved, grantScopeOnce: approved };
  };
  return { cwd, binding, observed, open, pending, decision, get works() { return works; },
    setMode: (mode: PermissionMode) => { permissionMode = mode; },
    advance: () => { now += 6 * 60_000; works.approvals.recover(); },
    restart: () => { works = new WorkService(db.connection, { bots, now: () => now }); } };
}
try {
  for (const command of ["pwd;touch injected", "pwd && touch injected", "ls >file", "cat $(touch injected)",
    "cat `touch injected`", "pwd\ntouch injected", "ls -la", "cat -n file", "bash -c pwd", "ls -- file", "cat *", "cat ~/file"]) {
    assert.equal(workShellRead("bash", { command }), undefined, `unsafe/unsupported command stays gated: ${command}`);
  }
  for (const name of ["powershell", "terminal_exec", "mcp_call_tool"]) assert.equal(workShellRead(name, { command: "pwd" }), undefined);
  assert.deepEqual(workShellRead("bash", { command: "pwd" }), { path: ".", directory: true });
  assert.deepEqual(workShellRead("bash", { command: "ls" }), { path: ".", directory: true });
  assert.deepEqual(workShellRead("bash", { command: 'cat "file with spaces.txt"' }), { path: "file with spaces.txt", directory: false });
  console.log("PASS Work shell reads use complete narrow grammar; compound commands, expansion, redirects and flags remain gated");

  const queuedWorks = new WorkService(db.connection, { bots });
  const forbiddenPort = async (): Promise<never> => { throw new Error("Queue persistence test must not invoke a model/native execution port"); };
  const adapter = new WorkExecutionAdapter(queuedWorks, { prepare: forbiddenPort, find: forbiddenPort, submit: forbiddenPort,
    inspect: forbiddenPort, stop: forbiddenPort }, LOCAL_USER_ID, () => true, () => assert.fail("Unexpected native execution"));
  let selectedMode: PermissionMode = "default";
  const queue = new WorkDispatchQueue(db, queuedWorks, adapter, () => true, () => "fixture/not-used", () => selectedMode);
  try {
    for (const mode of ["default", "auto", "readonly"] as const) {
      selectedMode = mode;
      const created = queuedWorks.createWork(user, { operationId: `queue-mode-${mode}`, title: `Queue ${mode}`,
        workspacePath: root, inputSnapshotId: `queue-input-${mode}`, authorization: DESKTOP_USER_GRANTS }); assert(created.ok);
      queue.enqueue(created.work, `queue-enqueue-${mode}`);
      const row = db.connection.prepare("SELECT task_id FROM work_dispatch_requests WHERE operation_id=?").get(`queue-enqueue-${mode}`);
      assert(row && typeof row === "object" && "task_id" in row && typeof row.task_id === "string");
      assert.equal(db.getTask(row.task_id)?.permissionMode, mode, "new queued task inherits current callback mode, not a hardcoded auto grant");
      selectedMode = mode === "auto" ? "readonly" : "auto";
      queue.enqueue(created.work, `queue-enqueue-${mode}`);
      assert.equal(db.getTask(row.task_id)?.permissionMode, mode, "duplicate enqueue preserves the existing task policy");
    }
  } finally { await queue.close(); await adapter.close(); }
  db.connection.prepare("UPDATE work_dispatch_requests SET state='cancelled' WHERE state='pending'").run();
  console.log("PASS WorkDispatchQueue persists default/auto/readonly from its current callback without native/model calls");

  for (const scenario of ["approve", "restart", "deny", "pause-restart", "timeout", "stale", "mode-change"] as const) {
    const f = await fixture(`native-${scenario}`, scenario === "deny");
    assert.equal(resolveWorkContinuationCwd(db, f.works, f.binding.taskId), undefined,
      "ordinary task without a persisted continuation plan cannot borrow a directory");
    if (scenario === "deny") assert.equal(f.works.getWork(f.binding.workId)?.workspacePath, undefined);
    let runtime = await f.open();
    try {
      const submission = await runtime.submit("pwd, write proof.txt, ls, read proof.txt", `input-${scenario}`);
      await until(() => !!f.pending());
      const approval = f.pending()!;
      assert.equal(approval.toolName, "write"); assert.equal(approval.requiredScope, "workspace:write"); assert(approval.scopeMissing);
      assert.equal(f.observed.filter(x => x.name === "bash").length, 1, "pwd completed once before the prompt");
      assert(f.observed[0]?.body.includes(f.cwd), "pwd returned real temporary workspace");
      await assert.rejects(access(join(f.cwd, "proof.txt")), "no write before approval");
      assert.equal(interactions.listByTask(f.binding.taskId).length, 0, "Work approval does not create ordinary chat questions");
      assert.equal(f.works.repo.listAdmissions(f.binding.workId).filter(a => a.actionKind === "workspace:write").length, 0);
      await assert.rejects(f.works.approvals.request({ taskId: f.binding.taskId, operationId: approval.operationId,
        toolName: "write", arguments: { path: "other.txt", content: "not authorized" }, actionKind: "workspace:write",
        summary: "different file", permissionMode: "auto", needsApproval: true }), /审批动作身份/,
        "an approval operation cannot be rebound to different tool arguments");
      assert.equal(f.works.approvals.decide("different-user", f.decision(approval)).ok, false);
      f.works.transaction(() => f.works.partialResults.record(f.binding, [{ itemId: "completed-pwd", task: "Locate the workspace",
        required: true, dependencies: [], criterionIds: [], nativeStatus: "done", outcome: "completed",
        artifactRefs: [], writeConflicts: [], summary: f.observed[0]!.body, origin: "native" }], Date.now()));
      const preservedOutput = f.works.partialResults.list(f.binding.workId).find(x => x.itemId === "completed-pwd");
      const initialAccepted = f.works.getWork(f.binding.workId)!.acceptedDeliverableIds;
      let currentSubmission = submission;
      if (scenario === "restart") {
        await runtime.close(); f.restart(); runtime = await f.open();
        const restored = await runtime.harness.submission(submission.id, ctx); assert(restored);
        currentSubmission = restored;
        assert.equal(f.pending()?.approvalId, approval.approvalId);
        assert.equal(f.pending()?.expiresAt, approval.expiresAt, "restart does not extend deadline");
      }
      if (scenario === "mode-change") f.setMode("readonly");
      if (scenario === "pause-restart") {
        assert(f.works.pauseWork(user, { operationId: "pause-pending-approval", workId: f.binding.workId }).ok);
        f.works.approvals.recover();
        assert.equal((await currentSubmission.wait(ctx)).status, "done");
        await runtime.close(); f.restart(); runtime = await f.open();
        const restored = await runtime.harness.submission(submission.id, ctx); assert(restored); currentSubmission = restored;
        assert.equal(f.works.approvals.list(f.binding.workId)[0]?.status, "invalidated");
        assert(f.works.resumeWork(user, { operationId: "resume-pending-approval", workId: f.binding.workId }).ok);
        assert.equal(f.works.approvals.decide(LOCAL_USER_ID, f.decision(approval)).ok, false,
          "pause/reopen cannot revive stale approval");
      } else if (scenario === "timeout") f.advance();
      else if (scenario === "stale") {
        const work = f.works.getWork(f.binding.workId)!;
        f.works.repo.updateWork({ ...work, intentRevision: work.intentRevision + 1, stateVersion: work.stateVersion + 1 });
        assert.equal(f.works.approvals.decide(LOCAL_USER_ID, f.decision(approval)).ok, false);
      } else {
        const decision = f.decision(approval, scenario !== "deny");
        if (scenario !== "deny") assert.equal(f.works.approvals.decide(LOCAL_USER_ID, { ...decision, grantScopeOnce: false }).ok, false,
          "missing Work scope requires explicit limited grant");
        const result = f.works.approvals.decide(LOCAL_USER_ID, decision); assert(result.ok);
        const duplicate = f.works.approvals.decide(LOCAL_USER_ID, decision); assert(duplicate.ok && duplicate.replayed);
        assert.equal(f.works.approvals.decide(LOCAL_USER_ID, { ...decision, approved: !decision.approved }).ok, false);
      }
      assert.equal((await currentSubmission.wait(ctx)).status, "done");
      const success = scenario === "approve" || scenario === "restart";
      const final = f.works.approvals.list(f.binding.workId);
      assert.equal(final.length, 1, "no duplicate approval after resume");
      assert.deepEqual(f.works.partialResults.list(f.binding.workId).find(x => x.itemId === "completed-pwd"), preservedOutput,
        "approval transitions retain prior successful output without rewriting it");
      if (scenario === "deny" || scenario === "timeout" || scenario === "pause-restart") {
        const gaps = f.works.partialResults.list(f.binding.workId).filter(x => x.outcome === "not_started");
        assert.equal(gaps.length, 1); assert.equal(gaps[0]?.itemId, approval.approvalId);
        assert.equal(gaps[0]?.bindingId, f.binding.bindingId);
        assert.equal(gaps[0]?.nativeStatus, "host_approval_not_started");
      }
      assert.equal(final[0]?.status, success ? "consumed" : scenario === "deny" ? "denied" : scenario === "timeout" ? "expired" : scenario === "mode-change" ? "denied" : "invalidated");
      assert.deepEqual(f.works.getWork(f.binding.workId)!.authorization.allowedScopes, ["workspace:read"]);
      assert.deepEqual(f.works.repo.getBinding(f.binding.bindingId)!.delegatedScope, ["workspace:read"]);
      assert.deepEqual(f.works.getWork(f.binding.workId)!.acceptedDeliverableIds, initialAccepted, "tool success never implies business acceptance");
      assert.equal(f.works.approvals.permits(f.binding.bindingId, approval.operationId, "workspace:write"), false, "grant cannot be reused");
      if (success) {
        assert.equal(await readFile(join(f.cwd, "proof.txt"), "utf8"), "native proof\n");
        assert.deepEqual(f.observed.map(x => x.name), ["bash", "write", "bash", "bash", "read"], "only remaining steps continue, pwd not rerun");
        assert(f.observed.every(x => !x.error)); assert(f.observed.at(-1)?.body.includes("native proof"));
        assert.equal(f.works.repo.listAdmissions(f.binding.workId).filter(a => a.actionKind === "workspace:write" && a.state === "consumed").length, 1);
        const duplicate = await runtime.submit("pwd, write proof.txt, ls, read proof.txt", `input-${scenario}`);
        assert.equal(duplicate.id, submission.id); assert.equal((await duplicate.wait(ctx)).status, "done");
        assert.equal(f.observed.length, 5, "repeated delivery does not reexecute model steps");
      } else {
        await assert.rejects(access(join(f.cwd, "proof.txt")));
        assert.equal(f.observed.length, 2); assert(f.observed[1]?.error);
        assert(f.works.repo.listOpenBlockers(f.binding.workId).length > 0, "retain actionable blocker");
      }
      if (scenario === "deny" || scenario === "pause-restart") {
        f.works.repo.updateBinding({ ...f.binding, status: "completed" });
        const work = f.works.getWork(f.binding.workId)!;
        const continued = f.works.continueWork(user, { operationId: `continue-exact-gap-${scenario}`, workId: work.workId, sourceBindingId: f.binding.bindingId,
          gapItemIds: [approval.approvalId], reason: "Retry only the original denied write", versionGuard: {
            expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch } });
        assert(continued.ok, JSON.stringify(continued));
        // Other runtime-only cases deliberately do not use WorkExecutionAdapter;
        // close their fixture bindings before exercising its global queue drain.
        for (const id of ["native-approve", "native-restart"]) {
          const prior = f.works.repo.bindingForTask(id); if (prior) f.works.repo.updateBinding({ ...prior, status: "completed" });
        }
        const errors: unknown[] = [], submissions: string[] = [];
        let nextTaskId = "";
        const receipts = new Map<string, import("../src/shared/agent-ipc").AgentSubmissionReceipt>();
        const continuationAdapter = new WorkExecutionAdapter(f.works, {
          resourceBoundary: "host-action-gate",
          prepare: async taskId => {
            const inherited = resolveWorkContinuationCwd(db, f.works, taskId);
            assert.equal(inherited, f.cwd, "versioned continuation inherits source binding directory, even when Work has no workspacePath");
            assert(inherited);
            const plan = f.works.partialResults.plans(work.workId).find(p => p.sourceBindingId === f.binding.bindingId)!;
            const rejectChangedIdentity = (label: string, change: () => void) => {
              const rollback = new Error(`rollback:${label}`);
              assert.throws(() => db.connection.transaction(() => {
                change();
                assert.throws(() => resolveWorkContinuationCwd(db, f.works, taskId), /不能改用新目录重跑/,
                  `${label} must reject rather than silently allocate a new directory`);
                throw rollback;
              })(), error => error === rollback);
              assert.equal(resolveWorkContinuationCwd(db, f.works, taskId), inherited, `${label} fixture is fully rolled back`);
            };
            rejectChangedIdentity("stale revision", () => {
              const current = f.works.getWork(work.workId)!;
              f.works.repo.updateWork({ ...current, intentRevision: current.intentRevision + 1 });
            });
            rejectChangedIdentity("cancelled request", () => db.connection.prepare("UPDATE work_dispatch_requests SET state='cancelled' WHERE task_id=?").run(taskId));
            rejectChangedIdentity("cancelled plan", () => db.connection.prepare("UPDATE work_continuation_plans SET state='cancelled' WHERE plan_id=?").run(plan.planId));
            rejectChangedIdentity("trashed source", () => db.upsertTaskExecutionWorkspaceState({ taskId: f.binding.taskId,
              directoryName: f.binding.taskId, state: "trashed", createdAt: Date.now(), updatedAt: Date.now(), trashedAt: Date.now() }));
            // Mirror AgentService's trusted helper -> persisted binding sequence.
            // Renderer cwd is not used as either the source or fallback.
            db.bindTaskExecutionWorkspaceCwd(taskId, inherited);
            assert.equal(db.getTask(taskId)?.cwd, f.cwd);
            return { taskId, durableStoreKey: `store:${taskId}`, conversationId: "1", workspaceBinding: inherited };
          },
          find: async binding => receipts.get(binding.bindingId),
          submit: async (binding, input) => {
            submissions.push(input); nextTaskId = binding.taskId;
            assert.equal(binding.workspaceBinding, f.cwd);
            assert.equal(db.getTask(binding.taskId)?.cwd, f.cwd);
            assert.notEqual(binding.taskId, f.binding.taskId, "new execution identity retains only the authorized old directory");
            assert(!input.includes("Locate the workspace"), "continuation excludes completed pwd item");
            assert(input.includes(approval.approvalId));
            const request = { taskId: binding.taskId, taskRoot: f.cwd, operationId: `tool:1:service-${scenario}:continued-write`, toolName: "write",
              arguments: { path: "proof.txt", content: "native proof\n" }, actionKind: "workspace:write",
              summary: "Retry original write", permissionMode: "auto" as const, needsApproval: true };
            assert.equal(await f.works.approvals.request({ ...request, operationId: "different-write",
              arguments: { path: "unrequested.txt", content: "forbidden" } }), false, "continuation cannot write different arguments");
            await assert.rejects(access(join(f.cwd, "proof.txt")));
            const awaitingOriginal = f.works.approvals.request(request);
            assert.equal(await f.works.approvals.request({ ...request, operationId: "same-args-new-pending-call" }), false,
              "same pending gap cannot be claimed by a different call ID");
            assert.equal(await awaitingOriginal, true);
            assert.equal(f.works.admitTaskAction(binding.taskId, { operationId: request.operationId, actionKind: request.actionKind }), undefined);
            const resources = new WorkToolResourcePolicy(f.works.resourceGate, () => ({ taskId: binding.taskId,
              workId: binding.workId, bindingId: binding.bindingId, durableStoreKey: binding.durableStoreKey,
              conversationId: binding.conversationId, workspaceBinding: binding.workspaceBinding }));
            const resourceCall = { call: { type: "toolCall" as const, id: "continued-write", name: "write", arguments: request.arguments },
              sideEffect: true, paths: ["proof.txt"], context: { taskId: binding.taskId, conversationId: "1", nativeTaskId: `service-${scenario}`, taskRoot: f.cwd } };
            assert.equal(resources.before(resourceCall), undefined, "exact-action grant also authorizes the real resource boundary");
            await createWriteTool(f.cwd).execute("continued-write", request.arguments);
            assert.equal(await readFile(join(f.cwd, "proof.txt"), "utf8"), "native proof\n");
            resources.after(resourceCall, "consumed");
            if (scenario === "pause-restart") {
              // Exercise the durable approval projection after trusted resource recovery:
              // the real file was written and read back above; recovery's consumed admission
              // is its explicit prerequisite, not permission to execute the tool again.
              assert(f.works.pauseWork(user, { operationId: "pause-after-written-effect", workId: binding.workId }).ok);
              f.works.approvals.recover();
              const recoveryApproval = f.works.approvals.list(binding.workId).find(a => a.operationId === request.operationId)!;
              assert.equal(recoveryApproval.status, "invalidated");
              f.works.transaction(() => f.works.approvals.settleAction(binding.taskId, request.operationId, "consumed"));
              assert.equal(f.works.approvals.list(binding.workId).find(a => a.approvalId === recoveryApproval.approvalId)?.status, "invalidated",
                "invalidated approval cannot claim recovery without a consumed admission");
              const admitted = f.works.repo.listAdmissions(binding.workId).find(a => a.operationId === request.operationId)!;
              f.works.transaction(() => {
                f.works.repo.updateAdmissionState(admitted.admissionId, "consumed", Date.now());
                f.works.approvals.settleAction(binding.taskId, request.operationId, "consumed");
              });
              assert.equal(f.works.approvals.list(binding.workId).find(a => a.approvalId === recoveryApproval.approvalId)?.status, "consumed");
              assert(f.works.resumeWork(user, { operationId: "resume-after-recovered-effect", workId: binding.workId }).ok);
            } else {
              f.works.settleTaskAction(binding.taskId, request.operationId, "unknown");
              const unknownApproval = f.works.approvals.list(binding.workId).find(a => a.operationId === request.operationId)!;
              assert.equal(unknownApproval.status, "consumed"); assert.equal(unknownApproval.outcome, "unknown");
              assert(f.works.partialResults.gaps(binding.workId).some(x => x.itemId === approval.approvalId),
                "unknown tool settlement must preserve the original gap");
              f.works.transaction(() => f.works.approvals.settleAction(binding.taskId, request.operationId, "consumed"));
              assert.equal(f.works.approvals.list(binding.workId).find(a => a.approvalId === unknownApproval.approvalId)?.outcome, "unknown",
                "consumed/unknown approval needs independent consumed-admission evidence");
              const unknownAdmission = f.works.repo.listAdmissions(binding.workId).find(a => a.operationId === request.operationId)!;
              // Seed the same verified-admission state that finalizeRecoveredResource
              // persists before invoking the approval projection under test.
              f.works.transaction(() => {
                f.works.repo.updateAdmissionState(unknownAdmission.admissionId, "consumed", Date.now());
                for (const blocker of f.works.repo.listOpenBlockers(binding.workId)) {
                  if (blocker.unknownExternalEffectRef === unknownAdmission.admissionId)
                    f.works.repo.clearBlocker(blocker.blockerId, binding.workId, Date.now());
                }
                f.works.approvals.settleAction(binding.taskId, request.operationId, "consumed");
              });
            }
            const settledApproval = f.works.approvals.list(binding.workId).find(a => a.operationId === request.operationId)!;
            const settledItems = f.works.partialResults.list(binding.workId);
            assert.equal(settledApproval.status, "consumed"); assert.equal(settledApproval.outcome, "consumed");
            assert(!f.works.repo.listOpenBlockers(binding.workId).some(x => x.blockerId === approval.approvalId));
            f.works.transaction(() => f.works.approvals.settleAction(binding.taskId, request.operationId, "consumed"));
            assert.deepEqual(f.works.approvals.list(binding.workId).find(a => a.operationId === request.operationId), settledApproval,
              "duplicate trusted recovery leaves approval version and outcome unchanged");
            assert.deepEqual(f.works.partialResults.list(binding.workId), settledItems,
              "duplicate recovery neither reopens nor duplicates completed gap results");
            assert.equal(await f.works.approvals.request({ ...request, operationId: "same-args-after-success" }), false,
              "completed gap cannot be repeated under a different call ID");
            const receipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" as const };
            receipts.set(binding.bindingId, receipt); return receipt;
          },
          inspect: async () => ({ status: "completed", summary: "Original write only", hasWriteConflicts: false,
            artifactRefs: [join(f.cwd, "proof.txt")], usageTokens: 1 }), stop: async () => {},
        }, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
        const continuationQueue = new WorkDispatchQueue(db, f.works, continuationAdapter, () => true, () => "fixture/not-used", () => "auto");
        try {
          const flushing = continuationQueue.flush();
          await until(() => !!f.works.approvals.list(work.workId).find(a => a.taskId === nextTaskId && a.status === "pending")).catch(error => { throw new Error(`${error}; ${errors.map(String).join("; ")}; approvals=${JSON.stringify(f.works.approvals.list(work.workId))}`); });
          const nextApproval = f.works.approvals.list(work.workId).find(a => a.taskId === nextTaskId && a.status === "pending")!;
          assert.notEqual(nextApproval.bindingId, f.binding.bindingId);
          await assert.rejects(access(join(f.cwd, "proof.txt")), "continued action also waits for its own approval");
          assert(f.works.approvals.decide(LOCAL_USER_ID, f.decision(nextApproval)).ok);
          await flushing; await continuationQueue.flush();
          assert.deepEqual(errors, []); assert.equal(submissions.length, 1);
          assert.equal(f.observed.filter(x => x.name === "bash").length, 1, "continuation did not replay original pwd");
          assert(f.works.partialResults.list(work.workId).some(x => x.itemId === approval.approvalId && x.bindingId === nextApproval.bindingId && x.outcome === "completed"));
          assert(!f.works.partialResults.gaps(work.workId).some(x => x.itemId === approval.approvalId));
          const offPlan = f.works.approvals.list(work.workId).find(a => a.operationId === "different-write");
          assert(offPlan && offPlan.status === "denied" && offPlan.outcome === "continuation-outside-plan",
            "rejected off-plan action remains visible in the approval audit");
          assert(!f.works.partialResults.list(work.workId).some(x => x.itemId === offPlan.approvalId),
            "unrequested off-plan action cannot create another required gap");
          assert(!f.works.repo.listOpenBlockers(work.workId).some(x => x.blockerId === offPlan.approvalId),
            "off-plan refusal cannot leave a pending blocker after the real gap completes");
          for (const operationId of ["same-args-new-pending-call", "same-args-after-success"]) {
            const repeat = f.works.approvals.list(work.workId).find(a => a.operationId === operationId)!;
            assert(repeat && repeat.status === "denied" && repeat.outcome === "continuation-outside-plan");
            assert(!f.works.partialResults.list(work.workId).some(x => x.itemId === repeat.approvalId));
            assert(!f.works.repo.listOpenBlockers(work.workId).some(x => x.blockerId === repeat.approvalId));
          }
          assert.deepEqual(f.works.partialResults.gaps(work.workId), []);
          assert(!f.works.repo.listOpenBlockers(work.workId).some(x => x.blockerId === approval.approvalId));
          assert.deepEqual(f.works.getWork(work.workId)!.acceptedDeliverableIds, initialAccepted);
          await assert.rejects(access(join(f.cwd, "unrequested.txt")));
          console.log(`PASS service queue continuation ${scenario}: inherits verified original directory, rejects stale/cancelled/trashed identity, retries only exact write, preserves pwd and resolves gap without acceptance`);
        } finally { await continuationQueue.close(); await continuationAdapter.close(); }
      }
      console.log(`PASS native Work approval ${scenario}: real SQLite/files/tools, scripted model only`);
    } finally { await runtime.close(); }
  }
  for (const conclusion of ["cancelled", "ended_unsuccessfully"] as const) for (const effect of ["pending", "admitted", "unknown"] as const) {
    const stopped = await fixture(`stop-${conclusion}-${effect}`);
    const request = { taskId: stopped.binding.taskId, operationId: `stop-operation-${effect}`, toolName: "write",
      arguments: { path: "never-created.txt", content: "fixture" }, actionKind: "workspace:write", summary: "Stop approval fixture",
      permissionMode: "auto" as const, needsApproval: true };
    const waiting = stopped.works.approvals.request(request);
    const approval = stopped.pending()!; assert(approval);
    if (effect !== "pending") {
      assert(stopped.works.approvals.decide(LOCAL_USER_ID, stopped.decision(approval)).ok);
      assert.equal(await waiting, true);
      assert.equal(stopped.works.admitTaskAction(stopped.binding.taskId, request), undefined);
      const admission = stopped.works.repo.listAdmissions(stopped.binding.workId).find(a => a.operationId === request.operationId)!;
      if (effect === "unknown") stopped.works.repo.updateAdmissionState(admission.admissionId, "unknown", Date.now());
      stopped.works.transaction(() => stopped.works.approvals.retireForStop(stopped.binding.workId));
      assert.equal(stopped.works.approvals.list(stopped.binding.workId)[0]?.status, "approved",
        "active or unknown side effects cannot be retired as not-started approvals");
    }
    const result = conclusion === "cancelled"
      ? stopped.works.cancelWork(user, { operationId: `cancel-pending-${effect}`, workId: stopped.binding.workId })
      : stopped.works.closeWork(user, { operationId: `end-pending-${effect}`, workId: stopped.binding.workId,
        conclusion, closureSummary: "Explicitly stop this fixture without claiming success" });
    assert(result.ok, JSON.stringify(result));
    if (effect === "pending") assert.equal(await waiting, false);
    assert(stopped.works.reconcileExecution({ kind: "system", reason: "fixture confirms stopped native binding" },
      { bindingId: stopped.binding.bindingId, outcome: "stopped", usageTokens: 0 }).ok);
    const work = stopped.works.getWork(stopped.binding.workId)!;
    if (effect === "pending") {
      assert.equal(work.lifecycle, "closed"); assert.equal(work.closureConclusion, conclusion);
      assert.equal(stopped.works.approvals.list(work.workId)[0]?.status, "invalidated");
      assert(!stopped.works.repo.listOpenBlockers(work.workId).some(x => x.blockerId === approval.approvalId));
      assert.deepEqual(stopped.works.partialResults.list(work.workId), [], "stopping is not an implicit request to create a continuation");
      stopped.restart(); stopped.works.approvals.recover();
      assert.equal(stopped.works.getWork(work.workId)?.lifecycle, "closed");
      assert(!stopped.works.repo.listOpenBlockers(work.workId).some(x => x.blockerId === approval.approvalId),
        "reopen cannot resurrect the retired approval blocker");
    } else {
      assert.equal(work.lifecycle, "closing", "unsettled side effects prevent closure even after native execution stops");
      assert(stopped.works.repo.listAdmissions(work.workId).some(a => a.operationId === request.operationId && a.state === effect));
      assert(!stopped.works.partialResults.list(work.workId).some(x => x.outcome === "not_started"));
    }
    await assert.rejects(access(join(stopped.cwd, "never-created.txt")));
  }
  console.log("PASS cancellation/end retire only pending approvals; admitted/unknown effects retain settlement obligations across stop");
  const uncertain = await fixture("native-uncertain-admission");
  const uncertainRequest = { taskId: uncertain.binding.taskId, operationId: "uncertain-operation", toolName: "write",
    arguments: { path: "unknown.txt", content: "unknown" }, actionKind: "workspace:write", summary: "Unknown effect fixture",
    permissionMode: "auto" as const, needsApproval: true };
  const awaiting = uncertain.works.approvals.request(uncertainRequest);
  const approval = uncertain.pending()!; assert(approval);
  assert(uncertain.works.approvals.decide(LOCAL_USER_ID, uncertain.decision(approval)).ok);
  assert.equal(await awaiting, true);
  assert.equal(uncertain.works.admitTaskAction(uncertain.binding.taskId,
    { operationId: uncertainRequest.operationId, actionKind: uncertainRequest.actionKind }), undefined);
  uncertain.advance();
  assert(uncertain.works.approvals.permits(uncertain.binding.bindingId, uncertainRequest.operationId, "workspace:write"),
    "action admitted before deadline retains grant during resource settlement");
  const admission = uncertain.works.repo.listAdmissions(uncertain.binding.workId).find(a => a.operationId === uncertainRequest.operationId)!;
  uncertain.works.repo.updateAdmissionState(admission.admissionId, "unknown", Date.now());
  uncertain.advance();
  assert.equal(uncertain.works.approvals.list(uncertain.binding.workId)[0]?.status, "approved");
  assert(!uncertain.works.partialResults.list(uncertain.binding.workId).some(x => x.outcome === "not_started"),
    "unknown effect cannot be mislabeled as unexecuted just because approval deadline elapsed");
  assert.equal(uncertain.works.approvals.permits(uncertain.binding.bindingId, uncertainRequest.operationId, "workspace:write"), false,
    "unknown effect needs recovery, never fresh execution permission");
  assert.equal(await uncertain.works.approvals.request(uncertainRequest), false, "re-entering the original tool after unknown admission is fenced");
  assert(!uncertain.works.partialResults.list(uncertain.binding.workId).some(x => x.outcome === "not_started"));
  console.log("PASS admitted action survives approval deadline; unknown effect is neither replayable nor mislabeled not_started");
  for (const priorState of ["none", "admitted", "unknown"] as const) {
    const delegate = await fixture(`delegate-denial-${priorState}`);
    const request = { taskId: delegate.binding.taskId, operationId: `delegate-op-${priorState}`, toolName: "subagent",
      arguments: { task: "Fixture delegation must remain under existing host policy" }, actionKind: "delegate",
      summary: "Delegate fixture", permissionMode: "auto" as const, needsApproval: true };
    assert.equal(await delegate.works.approvals.request(request), undefined,
      "ordinary delegation must continue through existing policy, never gain workspace one-shot authorization");
    assert.deepEqual(delegate.works.approvals.list(delegate.binding.workId), []);
    assert.deepEqual(delegate.works.repo.listOpenBlockers(delegate.binding.workId), []);
    if (priorState !== "none") {
      // Historical host admission fixture: test recovery projection, not new
      // authority to perform delegation or invoke an external/live agent.
      const work = delegate.works.getWork(delegate.binding.workId)!;
      delegate.works.repo.insertAdmission({ admissionId: `delegate-admission-${priorState}`, workId: work.workId,
        bindingId: delegate.binding.bindingId, operationId: request.operationId, actionKind: "delegate", state: priorState,
        intentRevision: work.intentRevision, ownerEpoch: work.ownerEpoch, admittedAt: Date.now() });
    }
    const refusal = { ...request, deniedReason: "Fixture host explicitly rejects delegation outside this member scope" };
    assert.equal(await delegate.works.approvals.request(refusal), false);
    const approval = delegate.works.approvals.list(delegate.binding.workId)[0]!; assert(approval);
    assert.equal(approval.requiredScope, "delegate");
    assert.equal(approval.status, priorState === "none" ? "denied" : "invalidated");
    assert.equal(delegate.works.approvals.decide(LOCAL_USER_ID, delegate.decision(approval)).ok, false,
      "explicit delegate refusal cannot be converted to an approval through decide");
    assert.equal(delegate.works.approvals.permits(delegate.binding.bindingId, request.operationId, "delegate"), false);
    assert.deepEqual(delegate.works.partialResults.list(delegate.binding.workId), [],
      "delegate refusal is a durable blocker, never a workspace write continuation gap");
    const blockers = delegate.works.repo.listOpenBlockers(delegate.binding.workId);
    assert.equal(blockers.length, 1); assert.equal(blockers[0]?.blockerId, approval.approvalId);
    assert.equal(blockers[0]?.waitingForUserInput, true);
    if (priorState !== "none") {
      assert(approval.outcome?.includes("原动作已有执行准入或未知效果"));
      assert(!blockers[0]!.reason.includes("未执行"), "admitted/unknown delegation must not be described as never executed");
      assert.equal(delegate.works.repo.listAdmissions(delegate.binding.workId)[0]?.state, priorState);
    }
    const version = delegate.works.getWork(delegate.binding.workId)!.stateVersion;
    assert.equal(await delegate.works.approvals.request(refusal), false);
    assert.deepEqual(delegate.works.approvals.list(delegate.binding.workId), [approval]);
    assert.deepEqual(delegate.works.repo.listOpenBlockers(delegate.binding.workId), blockers);
    assert.equal(delegate.works.getWork(delegate.binding.workId)!.stateVersion, version,
      "duplicate refused operation does not create approval/blocker/version churn");
  }
  console.log("PASS delegate policy fallback remains unchanged; explicit refusals persist once, cannot grant scope, and preserve prior effect uncertainty without write gaps");
  await assert.rejects(access(shellMarker), "native pwd/ls/cat reads must not source attacker BASH_ENV");
  await assert.rejects(access(pathMarker), "native ls/cat reads must not execute attacker PATH commands");
  console.log("PASS native pwd/ls/cat bypass hostile BASH_ENV and PATH commands using actual environment file APIs");
} finally {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (originalBashEnv === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = originalBashEnv;
  db.close(); await rm(root, { recursive: true, force: true });
}
