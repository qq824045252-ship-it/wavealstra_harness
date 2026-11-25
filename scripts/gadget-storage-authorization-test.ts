/**
 * Gadget state writes must be authorized by the invocation that asked for them.
 *
 * Part 1 drives the real transport: a write queued behind a busy lane is dropped
 * once its invocation is retired, without ever reaching the worker.
 * Part 2 drives the real host/runtime protocol: an aborted action retires its
 * invocation, the exiting host retires its generation, and later dequeues see it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeAuditReader } from "../src/main/platform/runtime-audit";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import type { GadgetStateAction, GadgetStateAuthorization, GadgetStateBucket, GadgetStateReply } from "../src/main/gadget/GadgetState";
import type { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import type { GadgetDescriptor } from "../src/shared/gadget-types";

const fixtures = join(process.cwd(), "out", "tests");
mkdirSync(fixtures, { recursive: true });

const workerSource = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const directory = __dirname;",
  "let config = {};",
  'try { config = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")); } catch {}',
  "const exitOn = new Set(config.exit || []);",
  'let buffered = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", chunk => {',
  "  buffered += chunk;",
  "  let index;",
  '  while ((index = buffered.indexOf("\\n")) >= 0) {',
  "    const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);",
  "    if (!line.trim()) continue;",
  "    const request = JSON.parse(line);",
  '    fs.appendFileSync(path.join(directory, "requests.log"), JSON.stringify({ pid: process.pid, operation: request.operation }) + "\\n");',
  "    if (exitOn.has(request.operation)) {",
  "      if (!config.exitWhenReleased) process.exit(3);",
  '      setInterval(() => { if (fs.existsSync(path.join(directory, "release-exit"))) process.exit(3); }, 5); continue;',
  "    }",
  '    process.stdout.write(JSON.stringify({ status: "ok", data: null, replyId: request.requestId }) + "\\n");',
  "  }",
  "});",
  "",
].join("\n");

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

/** The worker retires the whole process; the write is still sitting in the TS lane. */
async function queuedWriteIsDroppedAfterRetirement(): Promise<void> {
  const directory = mkdtempSync(join(fixtures, "gadget-authorization-transport-"));
  const worker = join(directory, "fake-rust.cjs");
  writeFileSync(worker, workerSource);
  writeFileSync(join(directory, "config.json"), JSON.stringify({ exit: ["snapshots"] }));
  const data = join(directory, "data");
  mkdirSync(data);
  const reader = new RuntimeAuditReader(process.execPath, worker);
  let retired = false;
  try {
    const busy = reader.snapshots("fixture-task", 1);
    const write = reader.accessGadgetState(data, realpathSync(data), "storage",
      { operation: "set", key: [107], valueJson: "{\"value\":1}", writeId: randomUUID() } as GadgetStateAction & { writeId: string },
      { generation: "generation-1", invocationId: "invocation-1", expiresAt: Date.now() + 60_000 },
      () => retired);
    // The invocation is cancelled while the write waits behind the busy lane.
    retired = true;
    assert.equal(await busy, undefined);
    assert.deepEqual(await write, { kind: "error", error: "STALE_WRITE" },
      "a queued write reports that it was not committed");
    const reached = readFileSync(join(directory, "requests.log"), "utf8");
    assert(!reached.includes("gadgetState"), "the retired write never reaches the worker");
    console.log("PASS a write queued behind a retired invocation never reaches the worker");
  } finally {
    await reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Retirement after dispatch cannot establish whether the worker committed. */
async function dispatchedWriteDoesNotClaimCancellation(): Promise<void> {
  const directory = mkdtempSync(join(fixtures, "gadget-authorization-unknown-"));
  const worker = join(directory, "fake-rust.cjs");
  writeFileSync(worker, workerSource);
  writeFileSync(join(directory, "config.json"), JSON.stringify({ exit: ["gadgetState"], exitWhenReleased: true }));
  const data = join(directory, "data");
  mkdirSync(data);
  const reader = new RuntimeAuditReader(process.execPath, worker);
  let retired = false;
  try {
    await reader.snapshots("warmup", 1);
    const write = reader.accessGadgetState(data, realpathSync(data), "storage",
      { operation: "set", key: [107], valueJson: "1", writeId: randomUUID() },
      { generation: "generation-1", invocationId: "invocation-1", expiresAt: Date.now() + 60_000 },
      () => retired);
    await waitFor(() => readFileSync(join(directory, "requests.log"), "utf8").includes("gadgetState"),
      2_000, "write dispatch before retirement");
    assert.equal(reader.laneDiagnostics().inFlight.database, 1);
    retired = true;
    writeFileSync(join(directory, "release-exit"), "1");
    assert.deepEqual(await write, { kind: "error", error: "STORAGE_UNAVAILABLE" },
      "retirement cannot turn a lost dispatched write reply into proof that no commit occurred");
    assert.equal(reader.laneDiagnostics().unconfirmed.length, 1,
      "the dispatched write remains an unknown outcome");
    console.log("PASS a dispatched write with a lost reply is not mislabeled as cancelled");
  } finally {
    await reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

interface RecordedStateCall {
  bucket: GadgetStateBucket;
  action: GadgetStateAction & { writeId: string };
  authorization: GadgetStateAuthorization;
  receivedAt: number;
  allowedAtArrival: boolean;
  retired: () => boolean;
}

/** An action that queues a write and then runs past its own timeout. */
async function abortedActionRetiresItsWrites(): Promise<void> {
  const root = mkdtempSync(join(fixtures, "gadget-authorization-"));
  writeFileSync(join(root, "index.html"), "<body>authorization fixture</body>");
  writeFileSync(join(root, "server.mjs"), [
    "export default function createBackend(context) {",
    "  return { actions: { slow: async () => { await context.storage.set(\"k\", 1); return \"unreachable\"; } } };",
    "}",
    "",
  ].join("\n"));
  mkdirSync(join(root, "data"));
  const calls: RecordedStateCall[] = [];
  const queued: Array<() => void> = [];
  const revokedInvocations: string[] = [];
  const revokedGenerations: string[] = [];
  const audit = {
    openGadgetState: async (path: string) => ({ kind: "opened" as const, canonicalPath: realpathSync(path) }),
    accessGadgetState: (_path: string, _canonical: string, bucket: GadgetStateBucket, action: RecordedStateCall["action"],
      authorization: GadgetStateAuthorization, retired: () => boolean) => {
      calls.push({ bucket, action, authorization, receivedAt: Date.now(), allowedAtArrival: !retired(), retired });
      // The write stays queued while the action is cancelled; the test releases it.
      return new Promise<GadgetStateReply>(resolve => queued.push(() => resolve({ kind: "error", error: "STALE_WRITE" })));
    },
    revokeGadgetInvocation: async (_generation: string, invocationId: string) => {
      revokedInvocations.push(invocationId);
      return true;
    },
    revokeGadgetGeneration: async (generation: string) => {
      revokedGenerations.push(generation);
      return true;
    },
  };
  const storage = {
    materializeLegacyLocalHtmlRedirect: () => false,
    readManifest: () => ({ entry: "index.html", backend: { entry: "server.mjs", timeoutMs: 300 } }),
    paths: () => ({ sourcePath: root, dataPath: join(root, "data") }),
  } as unknown as GadgetStorage;
  const registry = new GadgetRegistry();
  const runtime = new GadgetRuntime(storage, registry, undefined, audit as unknown as RuntimeAuditReader);
  const descriptor = { id: "fixture-authorization" } as GadgetDescriptor;
  try {
    const state = await runtime.start(descriptor);
    assert.equal(state.status, "running");
    await assert.rejects(runtime.request(descriptor, "actions/slow", {}),
      (error: Error & { code?: string }) => error.code === "ACTION_TIMEOUT",
      "a cancelled action reports a timeout");
    await waitFor(() => revokedInvocations.length === 1, 5_000, "the invocation revocation");
    const call = calls[0];
    assert(call, "the action's write reached the host bridge");
    assert.equal(call.authorization.invocationId, revokedInvocations[0],
      "the retired invocation is the one that queued the write");
    assert.equal(call.authorization.generation.length > 0, true);
    // The lease is the action budget: once it passes, the worker refuses the commit.
    assert.equal(call.authorization.expiresAt > 0, true, "an action write carries a bounded lease");
    assert(call.authorization.expiresAt <= call.receivedAt + 300, "the lease never outlives the action budget");
    assert.equal(call.allowedAtArrival, true, "the write arrived while its action was still live");

    // A non-cooperative handler is killed, and its whole generation retires with it.
    await waitFor(() => revokedGenerations.length === 1, 5_000, "the generation revocation");
    assert.equal(revokedGenerations[0], call.authorization.generation);
    assert.equal(call.retired(), true, "a later dequeue sees the retired invocation");
    console.log("PASS an aborted action retires its invocation, and the exit retires its generation");
  } finally {
    queued.splice(0).forEach(release => release());
    await runtime.disposeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await queuedWriteIsDroppedAfterRetirement();
  await dispatchedWriteDoesNotClaimCancellation();
  await abortedActionRetiresItsWrites();
}

void main();
