import assert from "node:assert/strict";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { withDurableToolCoordination } from "../src/main/agent/durable/DurableToolCoordination";

const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

export async function verifyDurableToolCoordination(root: string): Promise<void> {
  const cwd = join(root, "actual-tool-coordination");
  await mkdir(cwd);
  const target = join(cwd, "target.txt"), other = join(cwd, "other.txt");
  await writeFile(target, "old");
  const notStarted: unknown[] = [];
  const api = { agent: async () => ({ cwd }), taskId: 12, conversationId: 3, callId: "controlled-call",
    memo: async (_name: string, candidate: unknown) => { notStarted.push(candidate); return candidate; } } as unknown as ToolExecutionApi;
  const run = (name: string, args: Record<string, unknown>, body: () => Promise<void>, signal?: AbortSignal, beforeExecute?: () => void) => {
    const tool = withDurableToolCoordination(defineTool({ name, description: "Controlled tool with real filesystem effects", parameters: Type.Object({}, { additionalProperties: true }), replay: "safe",
      execute: async () => { await body(); return { output: [{ type: "text", text: "done" }] }; } }), cwd, beforeExecute);
    return tool.execute(args, api, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
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
    await run("work_cancel", { workId: "held-operation" }, async () => {});
    assert.equal(started, false, "opaque commands cannot gain parallel write access by declaring readOnly or a misleading path");
    release.release(); await Promise.all([command, after]);
  }

  const shellEntered = deferred(), releaseShell = deferred();
  const shell = run("bash", { command: "long running program" }, async () => {
    shellEntered.release(); await releaseShell.promise; await writeFile(target, "shell finished");
  });
  await shellEntered.promise;
  let queuedWriteStarted = false;
  const queuedWrite = run("write", { path: other }, async () => { queuedWriteStarted = true; await writeFile(other, "worker wrote"); });
  const controls = ["work_query_status", "work_create", "work_amend", "work_team_create", "work_team_replan",
    "foreground_query_requests", "foreground_cancel_request"];
  const completedControls: string[] = [];
  const requests = controls.map(name => run(name, {}, async () => { completedControls.push(name); }));
  try {
    await turn();
    assert.deepEqual(completedControls, controls, "host status, creation, replanning and cancellation stay responsive during a running shell");
    assert.equal(queuedWriteStarted, false, "dispatch control cannot release a queued worker's actual file write");
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
  assert.deepEqual(notStarted.at(-1), { toolName: "read", callId: "controlled-call", taskId: 12, conversationId: 3, phase: "validation" });
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
  assert.deepEqual(notStarted.at(-1), { toolName: "write", callId: "controlled-call", taskId: 12, conversationId: 3, phase: "validation" });
  await assert.rejects(run("mcp_call_tool", { server: "opaque", tool: "run_script", arguments: {} }, async () => {
    assert.fail("a revoked MCP leaf must not execute");
  }, undefined, () => { throw new Error("MCP review expired"); }), /MCP review expired/);
  assert.deepEqual(notStarted.at(-1), { toolName: "mcp__opaque__run_script", callId: "controlled-call", taskId: 12, conversationId: 3, phase: "validation" });
  console.log("PASS actual tool boundaries: disjoint progress, read/read overlap, read/write waits, cross-dispatch identities, hardlinks/junctions, opaque shell/MCP writes, cancellation and error release");
}
