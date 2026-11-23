import assert from "node:assert/strict";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineTool, Harness, MemoryStorage, type Conversation, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import type { DurableCodeReview } from "../src/main/agent/durable/DurableCodeReview";
import { withDurableToolCoordination } from "../src/main/agent/durable/DurableToolCoordination";

const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

export async function verifyDurableToolCoordination(root: string): Promise<void> {
  const cwd = join(root, "actual-tool-coordination");
  await mkdir(cwd);
  const models = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
    modelsStorePath: join(cwd, "models.json"), refreshOnCreate: false });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd } });
    await verifyResourceLeases(cwd, conversation);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}

async function verifyResourceLeases(cwd: string, conversation: Conversation): Promise<void> {
  const target = join(cwd, "target.txt"), other = join(cwd, "other.txt");
  await writeFile(target, "old");
  const notStarted: unknown[] = [];
  const api = { agent: conversation.agent.bind(conversation), commit: conversation.commit.bind(conversation),
    taskId: 12, conversationId: conversation.id, callId: "controlled-call",
    memo: async (_name: string, candidate: unknown) => { notStarted.push(candidate); return candidate; } } as unknown as ToolExecutionApi;
  const run = (name: string, args: Record<string, unknown>, body: () => Promise<void>, signal?: AbortSignal, beforeExecute?: () => void,
    codeReview?: DurableCodeReview, env?: NodeExecutionEnv) => {
    const tool = withDurableToolCoordination(defineTool({ name, description: "Controlled tool with real filesystem effects", parameters: Type.Object({}, { additionalProperties: true }), replay: "safe",
      execute: async () => { await body(); return { output: [{ type: "text", text: "done" }] }; } }), cwd, beforeExecute, undefined, codeReview);
    return tool.execute(args, env ? { ...api, env } : api, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
  };

  const writerEntered = deferred(), releaseWriter = deferred();
  const writer = run("write", { path: target }, async () => {
    writerEntered.release(); await releaseWriter.promise; await writeFile(target, "new");
  });
  await writerEntered.promise;
  let readStarted = false;
  const reader = run("read", { path: target }, async () => {
    readStarted = true; assert.equal(await readFile(target, "utf8"), "new");
  });
  await run("write", { path: other }, async () => { await writeFile(other, "independent"); });
  assert.equal(await readFile(other, "utf8"), "independent", "an unrelated write advances while a conflicting read waits");
  assert.equal(readStarted, false);
  releaseWriter.release(); await Promise.all([writer, reader]);

  // A file URL can resolve to a filename containing a literal nonbreaking space.
  // A reviewed write receives the already-admitted absolute path.
  const unicodeTarget = join(cwd, "monthly\u00a0ledger.txt"), differentFile = join(cwd, "monthly ledger.txt");
  await writeFile(unicodeTarget, "old report");
  const reviewEnv = new NodeExecutionEnv({ cwd });
  const reviewEntered = deferred(), releaseReview = deferred();
  const codeReview: DurableCodeReview = { taskId: "controlled", workspace: cwd, review: { capture: () => undefined } };
  const reviewedWrite = run("write", { path: unicodeTarget }, async () => {
    reviewEntered.release(); await releaseReview.promise; await writeFile(unicodeTarget, "new report");
  }, undefined, undefined, codeReview, reviewEnv);
  await reviewEntered.promise;
  let unicodeRead: string | undefined, unicodeReadStarted = false;
  const sameFileRead = run("read", { path: unicodeTarget }, async () => {
    unicodeReadStarted = true;
    unicodeRead = await readFile(unicodeTarget, "utf8");
  });
  try {
    await turn();
    assert.equal(unicodeReadStarted, false, "a reviewed write must hold the exact admitted file's lease");
    await run("write", { path: differentFile }, async () => { await writeFile(differentFile, "separate file"); });
  } finally {
    releaseReview.release();
    await Promise.all([reviewedWrite, sameFileRead]);
    await reviewEnv.cleanup(BACKGROUND_CONTEXT);
  }
  assert.equal(unicodeRead, "new report");

  const readEntered = deferred(), releaseRead = deferred();
  const heldRead = run("read", { path: target }, async () => { readEntered.release(); await releaseRead.promise; });
  await readEntered.promise;
  await run("read", { path: target }, async () => { assert.equal(await readFile(target, "utf8"), "new"); });
  const hardlink = join(cwd, "alias.txt"); await link(target, hardlink);
  let aliasStarted = false;
  const aliasWrite = run("write", { path: hardlink }, async () => { aliasStarted = true; await writeFile(hardlink, "alias"); });
  await turn(); assert.equal(aliasStarted, false, "different dispatch wrappers share an inode-aware read/write boundary");
  releaseRead.release(); await Promise.all([heldRead, aliasWrite]);
  assert.equal(await readFile(target, "utf8"), "alias");

  const dir = join(cwd, "directory"), aliasDir = join(cwd, "directory-alias");
  await mkdir(dir); await symlink(dir, aliasDir, "junction");
  const aliasEntered = deferred(), releaseAlias = deferred();
  const firstAlias = run("write", { path: join(aliasDir, "new.txt") }, async () => {
    aliasEntered.release(); await releaseAlias.promise; await writeFile(join(aliasDir, "new.txt"), "created");
  });
  await aliasEntered.promise;
  let canonicalStarted = false;
  const canonicalRead = run("read", { path: join(dir, "new.txt") }, async () => {
    canonicalStarted = true; assert.equal(await readFile(join(dir, "new.txt"), "utf8"), "created");
  });
  await turn(); assert.equal(canonicalStarted, false, "new paths through a directory alias share their canonical target");
  releaseAlias.release(); await Promise.all([firstAlias, canonicalRead]);

  for (const name of ["bash", "powershell", "mcp__opaque__run_script", "library_save_artifact"]) {
    const entered = deferred(), release = deferred();
    const command = run(name, { command: "arbitrary program", readOnly: true, path: other }, async () => {
      entered.release(); await release.promise; await writeFile(target, name);
    });
    await entered.promise;
    let started = false;
    const after = run("read", { path: target }, async () => { started = true; assert.equal(await readFile(target, "utf8"), name); });
    await run("web_search", { query: "independent network query" }, async () => {});
    await run("conversation_goal_get", { taskId: "held-operation" }, async () => {});
    const actions = ["task", "steer", "pause", "stop"];
    const completed: string[] = [];
    const controls = actions.map(action => run("dots_action", { action, targetTaskId: "held-operation" }, async () => {
      completed.push(action);
    }));
    const readThroughDots = run("dots_action", { action: "read_file", path: target }, async () => { started = true; });
    try {
      await turn();
      assert.deepEqual(completed.sort(), actions.sort(), "Dots task controls remain available while an opaque tool holds a lease");
      assert.equal(started, false, "actual reads still await the opaque writer");
    } finally {
      release.release();
      await Promise.all([command, after, readThroughDots, ...controls]);
    }
  }

  const shellEntered = deferred(), releaseShell = deferred();
  const shell = run("bash", { command: "long running program" }, async () => {
    shellEntered.release(); await releaseShell.promise; await writeFile(target, "shell finished");
  });
  await shellEntered.promise;
  let queuedWriteStarted = false;
  const queuedWrite = run("write", { path: other }, async () => { queuedWriteStarted = true; await writeFile(other, "worker wrote"); });
  const controls = ["conversation_goal_get", "conversation_goal_create", "conversation_goal_update", "conversation_goal_propose_complete"];
  const completedControls: string[] = [];
  const requests = controls.map(name => run(name, {}, async () => { completedControls.push(name); }));
  try {
    await turn();
    assert.deepEqual(completedControls, controls, "Goal queries and updates stay responsive during a running shell");
    assert.equal(queuedWriteStarted, false, "Goal control cannot release a queued task's actual file write");
  } finally {
    releaseShell.release(); await Promise.all([shell, queuedWrite, ...requests]);
  }
  assert.equal(await readFile(other, "utf8"), "worker wrote");

  const entered = deferred(), release = deferred(), controller = new AbortController();
  const held = run("write", { path: target }, async () => { entered.release(); await release.promise; });
  await entered.promise;
  let cancelledExecuted = false;
  const cancelled = run("read", { path: target }, async () => { cancelledExecuted = true; }, controller.signal);
  await turn(); controller.abort(new Error("cancel queued call"));
  await assert.rejects(cancelled, /cancel queued call/); assert.equal(cancelledExecuted, false);
  assert.deepEqual(notStarted.at(-1), { toolName: "read", callId: "controlled-call", taskId: 12, conversationId: conversation.id, phase: "validation" });
  release.release(); await held;
  await assert.rejects(run("write", { path: target }, async () => { throw new Error("controlled tool failure"); }), /controlled tool failure/);
  await run("read", { path: target }, async () => { await readFile(target); });
  const activeEntered = deferred(), activeRelease = deferred(), activeAbort = new AbortController();
  const activeCall = run("write", { path: target }, async () => { activeEntered.release(); await activeRelease.promise; }, activeAbort.signal);
  await activeEntered.promise; activeAbort.abort();
  let afterAbortExecuted = false;
  const afterAbort = run("read", { path: target }, async () => { afterAbortExecuted = true; });
  await turn(); assert.equal(afterAbortExecuted, false, "abort does not release a still-executing effect before it settles");
  activeRelease.release(); await Promise.all([activeCall, afterAbort]);

  const revocationEntered = deferred(), revocationRelease = deferred();
  const previous = run("read", { path: target }, async () => { revocationEntered.release(); await revocationRelease.promise; });
  await revocationEntered.promise;
  let allowed = true, revokedExecuted = false;
  const revoked = run("write", { path: target }, async () => { revokedExecuted = true; }, undefined,
    () => { if (!allowed) throw new Error("Work paused while awaiting resource"); });
  await turn(); allowed = false; revocationRelease.release(); await previous;
  await assert.rejects(revoked, /Work paused/); assert.equal(revokedExecuted, false);
  assert.deepEqual(notStarted.at(-1), { toolName: "write", callId: "controlled-call", taskId: 12, conversationId: conversation.id, phase: "validation" });
  await assert.rejects(run("mcp_call_tool", { server: "opaque", tool: "run_script", arguments: {} }, async () => {
    assert.fail("a revoked MCP leaf must not execute");
  }, undefined, () => { throw new Error("MCP review expired"); }), /MCP review expired/);
  assert.deepEqual(notStarted.at(-1), { toolName: "mcp__opaque__run_script", callId: "controlled-call", taskId: 12, conversationId: conversation.id, phase: "validation" });
  console.log("PASS actual tool boundaries: disjoint progress, read/read overlap, read/write waits, cross-dispatch identities, hardlinks/junctions, opaque shell/MCP writes, cancellation and error release");
}
