import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createDurableArtifactRegistrationTool, withDurableArtifactRegistration, inspectDurableArtifact,
  durableRegisteredArtifact, DURABLE_ARTIFACT_ENTRY_KIND } from "../src/main/agent/durable/DurableArtifactRegistration";

const root = await mkdtemp(join(tmpdir(), "artifact-registration-"));
try {
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const path = join(cwd, "report.html");
  await writeFile(path, "<h1>shell-created output</h1>");
  const file = await inspectDurableArtifact(cwd, "report.html");
  assert.equal(file.path, path);
  assert.equal(file.digest, createHash("sha256").update("<h1>shell-created output</h1>").digest("hex"));
  assert.equal(file.sizeBytes, Buffer.byteLength("<h1>shell-created output</h1>"));
  await assert.rejects(inspectDurableArtifact(cwd, "."));
  await assert.rejects(inspectDurableArtifact(cwd, "missing.html"));
  await writeFile(join(root, "outside.html"), "outside");
  await assert.rejects(inspectDurableArtifact(cwd, "../outside.html"));
  await symlink(join(root, "outside.html"), join(cwd, "escape.html"));
  await assert.rejects(inspectDurableArtifact(cwd, "escape.html"));
  await symlink(path, join(cwd, "inside.html"));
  assert.equal((await inspectDurableArtifact(cwd, "inside.html")).path, path);
  const directory = join(root, "durable-store");
  const large = Buffer.alloc(160 * 1024, 0x61);
  await writeFile(join(cwd, "large.html"), large);
  const largeReceipt = await inspectDurableArtifact(cwd, "large.html", directory);
  assert.deepEqual(await readFile(largeReceipt.snapshotPath!), large, "multi-chunk snapshot preserves every byte");
  await writeFile(largeReceipt.snapshotPath!, "corrupt stored snapshot");
  await assert.rejects(inspectDurableArtifact(cwd, "large.html", directory), /integrity verification/);
  const entries: any[] = [];
  let transaction: Promise<any> = Promise.resolve();
  function serialized(fn: () => any) {
    const result = transaction.then(fn);
    transaction = result.catch(() => {});
    return result;
  }
  let inputIds = [71], callId = "register-1", taskId = 31;
  const api: any = {
    conversationId: 12, get callId() { return callId; }, get taskId() { return taskId; },
    agent: async () => ({ cwd }), output: () => {},
    snapshot: async (_doc: any, conversation: number) => { assert.equal(conversation, 10); return { run: { inputs: inputIds } }; },
    commit: async (fn: any) => serialized(() => fn({
      conversation: async (id: number) => ({ owner: id === 12 ? { conversationId: 10 } : undefined }),
      scanEntries: async () => ({ items: [...entries].reverse() }),
      appendEntry: async (_kind: any, conversationId: number, value: any) => {
        assert.equal(conversationId, 10);
        const entry = { id: entries.length + 100, kind: DURABLE_ARTIFACT_ENTRY_KIND, conversationId, ...value };
        entries.push(entry); return entry;
      },
    })),
  };
  const tool = createDurableArtifactRegistrationTool(directory);
  const beforeMissing = await readdir(directory, { recursive: true });
  const missing = await tool.execute({ path: "workspace/report.html" }, api, ctx);
  assert.equal(missing.isError, true, "known missing source remains a failed tool result");
  assert(JSON.stringify(missing.output).includes(JSON.stringify(join(cwd, "workspace/report.html")).slice(1, -1)));
  assert(JSON.stringify(missing.output).includes(JSON.stringify(cwd).slice(1, -1)));
  assert.equal(entries.length, 0, "missing source cannot append a receipt");
  assert.deepEqual(await readdir(directory, { recursive: true }), beforeMissing, "missing source creates no snapshot");
  assert.equal(await readFile(path, "utf8"), "<h1>shell-created output</h1>");
  const blockedStore = join(root, "not-a-directory");
  await writeFile(blockedStore, "keep");
  await assert.rejects(createDurableArtifactRegistrationTool(blockedStore).execute({ path }, api, ctx),
    "store I/O failure must remain an exception, not a known missing-source result");
  const failingCommitApi = { ...api, commit: async (fn: any) => fn({
    conversation: async () => ({ owner: undefined }), scanEntries: async () => ({ items: [] }),
    appendEntry: async () => { throw Object.assign(new Error("commit lost"), { code: "ENOENT" }); },
  }), snapshot: async () => ({ run: { inputs: [71] } }) };
  await assert.rejects(tool.execute({ path }, failingCommitApi, ctx), /commit lost/,
    "post-snapshot commit ENOENT must not be converted to a pre-write failure");
  await tool.execute({ path: "report.html" }, api, ctx);
  assert.equal(entries.length, 1);
  const receipt = durableRegisteredArtifact(entries[0], 71, cwd, directory)!;
  assert.equal(receipt.digest, file.digest);
  const alias = join(root, "workspace-alias"); await symlink(cwd, alias, "dir");
  assert.equal(durableRegisteredArtifact(entries[0], 71, alias, directory)?.digest, file.digest);
  assert.equal(receipt.toolCallId, callId);
  assert.equal(receipt.toolTaskId, taskId);
  assert.equal(receipt.toolConversationId, 12);
  assert(receipt.registeredAt > 0);
  assert.equal(durableRegisteredArtifact(entries[0], 72, cwd, directory), undefined);
  assert.equal(durableRegisteredArtifact(entries[0], 71, root, directory), undefined);
  assert.equal(durableRegisteredArtifact({ ...entries[0], kind: "pi.tool-result" }, 71, cwd, directory), undefined);
  assert.equal(await readFile(receipt.snapshotPath, "utf8"), "<h1>shell-created output</h1>");
  assert(receipt.snapshotPath.endsWith(".html"));
  assert.equal(durableRegisteredArtifact({ ...entries[0], data: { ...entries[0].data, snapshotPath: path } }, 71, cwd, directory), undefined);
  await writeFile(path, "new version");
  assert.equal(await readFile(receipt.snapshotPath, "utf8"), "<h1>shell-created output</h1>", "rewriting source cannot change saved bytes");
  await tool.execute({ path: "report.html" }, api, ctx);
  assert.equal(entries.length, 1, "recovered exact call reuses the durable receipt");
  callId = "register-2"; taskId++;
  await tool.execute({ path: "report.html" }, api, ctx);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[1].data.digest, file.digest);
  inputIds = [];
  await tool.execute({ path: "report.html" }, api, ctx);
  assert.equal(entries.length, 2, "recovery finds original call even after run identity changes");
  inputIds = [71];
  callId = "write-1"; taskId++;
  const write: any = { name: "write", execute: async () => ({ output: [], isError: false }) };
  await withDurableArtifactRegistration(write, directory).execute({ path }, api, ctx);
  assert.equal(entries.length, 3, "successful write gets trusted registration");
  callId = "write-failed"; taskId++;
  await withDurableArtifactRegistration({ ...write, execute: async () => ({ output: [], isError: true }) }, directory).execute({ path }, api, ctx);
  assert.equal(entries.length, 3, "failed write does not register");
  callId = "parallel-register"; taskId++;
  await Promise.all([tool.execute({ path }, api, ctx), tool.execute({ path }, api, ctx)]);
  assert.equal(entries.length, 4, "same native call racing produces one receipt");
  await rm(path);
  assert.equal(await readFile(receipt.snapshotPath, "utf8"), "<h1>shell-created output</h1>", "deleting source preserves snapshot");
  callId = "no-input"; taskId++;
  inputIds = [];
  await assert.rejects(tool.execute({ path }, api, ctx));
  console.log("durable artifact registration passed");
} finally { await rm(root, { recursive: true, force: true }); }

// Actual Pi durable runtime and shell; provider output is a deterministic fixture, not a live model.
const { DurableBotRuntime } = await import("../src/main/agent/durable/DurableBotRuntime");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/compat");
const { readDurableWorkExecution } = await import("../src/main/agent/durable/DurableWorkExecutionProjection");
const model: any = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false,
  input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
for (const mode of ["native", "codemode"] as const) {
  const root = await mkdtemp(join(tmpdir(), `artifact-runtime-${mode}-`));
  let calls = 0, registrationSeen = false;
  let release!: () => void;
  const afterRegistration = new Promise<void>(resolve => { release = resolve; });
  let runtime: Awaited<ReturnType<typeof DurableBotRuntime.open>>;
  const models: any = { getAuth: async () => undefined, getModel: () => model,
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      void Promise.resolve().then(async () => {
        calls++;
        const base: any = { role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        let tool: any;
        if (mode === "codemode" && calls === 1) tool = { name: "codemode", arguments: { code: 'await tools.bash({command:"printf shell-generated > report.html"}); await tools.register_artifact({path:"report.html"});' } };
        else if (mode === "native" && calls === 1) tool = { name: "bash", arguments: { command: "printf shell-generated > report.html" } };
        else if (mode === "native" && calls === 2) tool = { name: "register_artifact", arguments: { path: "report.html" } };
        if (tool) {
          const message = { ...base, content: [{ type: "toolCall", id: `call-${calls}`, ...tool }], stopReason: "toolUse" };
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          registrationSeen = true;
          await afterRegistration;
          stream.push({ type: "error", reason: "aborted", error: { ...base, content: [], stopReason: "aborted", errorMessage: "fixture provider stopped after registration" } });
        }
        stream.end();
      }).catch(error => { console.error(error); stream.end(); });
      return stream;
    },
  };
  models.completeSimple = (...args: any[]) => models.streamSimple(...args).result();
  try {
    runtime = await DurableBotRuntime.open({ directory: join(root, "state"), cwd: root, model: { provider: model.provider, modelId: model.id },
      toolMode: mode, instructions: () => "fixture", onSnapshot: () => {}, models });
    const submission = await runtime.submit("Generate report", `register-${mode}`);
    for (let i = 0; i < 500 && !registrationSeen; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(registrationSeen, `${mode}: native execution must reach registration before final response`);
    const scan = async () => runtime.harness.commit(async tx => {
      const page = await tx.scanEntries({ conversationId: runtime.conversation.id }, 500);
      return page.items;
    }, ctx);
    const entries = await scan();
    const registrations = entries.filter(entry => durableRegisteredArtifact(entry, submission.id, root, join(root, "state")));
    assert.equal(registrations.length, 1, `${mode}: trusted registration visible while generation is running`);
    const runningRecord = await submission.status(ctx);
    const running = await runtime.harness.commit(tx => readDurableWorkExecution(tx, runningRecord, root, join(root, "state")), ctx);
    assert.equal(running.status, "running");
    assert.equal(running.generatedArtifacts?.length, 1, "running projection exposes generated evidence");
    release();
    const settled = await submission.wait(ctx);
    assert.equal(settled.status, "unanswered");
    assert.equal((await scan()).filter(entry => durableRegisteredArtifact(entry, submission.id, root, join(root, "state"))).length, 1);
    const observation = await runtime.harness.commit(tx => readDurableWorkExecution(tx, settled, root, join(root, "state")), ctx);
    assert.notEqual(observation.status, "running");
    assert(observation.status !== "running" && observation.artifactRefs?.includes(durableRegisteredArtifact(registrations[0], submission.id, root, join(root, "state"))!.snapshotPath), `${mode}: stopped execution retains the registered file`);
    await runtime.close();
    runtime = await DurableBotRuntime.open({ directory: join(root, "state"), cwd: root, model: { provider: model.provider, modelId: model.id },
      toolMode: mode, instructions: () => "fixture", onSnapshot: () => {}, models });
    assert.equal((await scan()).filter(entry => durableRegisteredArtifact(entry, submission.id, root, join(root, "state"))).length, 1, "registration survives durable reopen");
    await runtime.close();
  } finally { release(); await rm(root, { recursive: true, force: true }); }
}
console.log("durable artifact runtime shell/register/stop/reopen fixtures passed");
