/** Behavioural fault injection against the real client and a serial worker. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeAuditReader, RuntimeAuditUnknownOperationError, RuntimeAuditNotStartedOperationError, RuntimeAuditOperationFailedError,
  type RuntimeSemanticModel } from "../src/main/platform/runtime-audit";

// Work is serialized per lane, exactly like the Rust workers. Control is handled
// immediately by the input reader, and is not held behind a business operation.
const workerSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const receipts = new Map();
const revoked = new Set();
const tails = new Map();
function log(request, stage) {
  fs.appendFileSync(path.join(__dirname, "requests.log"), JSON.stringify({
    pid: process.pid, operation: request.operation, action: request.action,
    requestId: request.requestId, targetRequestId: request.targetRequestId, stage, at: Date.now(),
  }) + "\n");
}
function reply(request, status, data, extra = {}) {
  const frame = { replyId: request.requestId, status, data, ...extra };
  if (config.omitId) delete frame.replyId;
  process.stdout.write(JSON.stringify(frame) + "\n");
}
function value(request) {
  if (request.operation.endsWith("Supported") || request.operation === "libraryMetadata") return true;
  if (request.operation === "startDotsFileWatch" || request.operation === "stopDotsFileWatch") return true;
  if (request.operation === "semanticInference") return { vector: [0.5, 0.25] };
  if (request.operation === "deleteLibrary") return { status: "deleted", itemIds: ["item-1"] };
  if (request.operation === "gadgetState") return { kind: "value", entry: { value: 1, revision: "revision-1" } };
  return null;
}
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  log(request, "received");
  if (request.operation === "control") {
    if (config.holdControl) return;
    if (request.action === "revokeGadget") {
      revoked.add(request.generation + ":" + (request.invocationId || "*"));
      return reply(request, "ok", { kind: "revoked" });
    }
    const receipt = receipts.get(request.targetRequestId);
    if (request.action === "cancel" && receipt && !config.ignoreCancel) {
      receipt.cancelRequested = true;
      if ((config.hang || []).includes(receipt.request.operation)) {
        receipt.state = "cancelled";
        reply(receipt.request, "cancelled", undefined, { neverStarted: false });
      }
    }
    return reply(request, "ok", receipt
      ? { requestId: request.targetRequestId, state: receipt.state,
          result: config.omitReceiptResult ? undefined : receipt.result, neverStarted: false }
      : { requestId: request.targetRequestId, state: "unknown" });
  }
  if (typeof request.requestId !== "string" || typeof request.deadlineAt !== "number") process.exit(4);
  if ((config.exit || []).includes(request.operation)) process.exit(3);
  if ((config.misroute || []).includes(request.operation)) {
    process.stdout.write(JSON.stringify({ status: "ok", data: "stray", replyId: "retired-request" }) + "\n");
  }
  const receipt = { requestId: request.requestId, request, state: "queued", cancelRequested: false };
  receipts.set(request.requestId, receipt);
  const previous = tails.get(request.lane) || Promise.resolve();
  const next = previous.then(async () => {
    if (receipt.cancelRequested || Date.now() >= request.deadlineAt) {
      receipt.state = receipt.cancelRequested ? "cancelled" : "expired";
      return reply(request, receipt.state, undefined, { neverStarted: true });
    }
    receipt.state = "running";
    log(request, "started");
    if ((config.fail || []).includes(request.operation)) {
      receipt.state = "failed";
      return reply(request, "error", undefined, { errorCode: "FAILED", neverStarted: false });
    }
    if ((config.hang || []).includes(request.operation)) return new Promise(() => {});
    const ms = (config.delayed || {})[request.operation] || 0;
    if (ms) await new Promise(resolve => setTimeout(resolve, ms));
    // ignoreCancel models non-interruptible work that has already passed its
    // irreversible boundary. Its eventual receipt, not a timeout, tells us how it ended.
    if (!config.ignoreCancel && (receipt.cancelRequested || Date.now() >= request.deadlineAt)) {
      receipt.state = receipt.cancelRequested ? "cancelled" : "expired";
      return reply(request, receipt.state);
    }
    if (request.operation === "gadgetState") {
      const auth = request.request.authorization;
      if (revoked.has(auth.generation + ":*") || revoked.has(auth.generation + ":" + auth.invocationId)) {
        receipt.state = "committed";
        receipt.result = { kind: "error", error: "STALE_WRITE" };
        return reply(request, "ok", receipt.result);
      }
      fs.writeFileSync(path.join(__dirname, "committed.json"), "1");
    }
    receipt.state = "committed";
    receipt.result = value(request);
    log(request, "committed");
    if ((config.holdReply || []).includes(request.operation)) return;
    reply(request, "ok", receipt.result);
  });
  tails.set(request.lane, next);
});
`;

interface LoggedRequest { pid: number; operation: string; action?: string; requestId: string; targetRequestId?: string; stage: string; at: number }
interface ReadSeam {
  read<T>(request: object, lane: string, allowAfterInferenceFailure: boolean, timeoutMs: number,
    expectedSession?: undefined, retired?: () => boolean, signal?: AbortSignal): Promise<T | undefined>;
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fixtures = join(process.cwd(), "out", "tests");
mkdirSync(fixtures, { recursive: true });
function fixture(name: string, config: object = {}) {
  const directory = mkdtempSync(join(fixtures, `runtime-audit-${name}-`));
  const worker = join(directory, "fake-rust.cjs");
  writeFileSync(worker, workerSource);
  const configure = (value: object) => writeFileSync(join(directory, "config.json"), JSON.stringify(value));
  configure(config);
  const reader = new RuntimeAuditReader(process.execPath, worker);
  const seam = reader as unknown as ReadSeam;
  const logged = (): LoggedRequest[] => {
    try { return readFileSync(join(directory, "requests.log"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  const model: RuntimeSemanticModel = { libraryPath: "/fixture/onnx", modelPath: "/fixture/model", tokenizerPath: "/fixture/tokenizer", dimension: 2 };
  return { directory, reader, seam, logged, configure, model,
    close: async () => { await reader.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
    await wait(10);
  }
}

async function deadlinesBeginAtEnqueue(): Promise<void> {
  const f = fixture("enqueue", { delayed: { snapshots: 600 } });
  try {
    let firstFinished = false;
    const first = f.seam.read({ operation: "snapshots" }, "database", false, 2_000).then(value => { firstFinished = true; return value; });
    await until(() => f.logged().some(row => row.stage === "started"), "first request start");
    assert.equal(await f.seam.read({ operation: "diagnostics" }, "database", false, 80), undefined);
    assert.equal(firstFinished, false, "the short request returns at its own deadline, before the long request ends");
    assert.equal(f.logged().some(row => row.operation === "diagnostics"), false, "expired queued work is never dispatched");
    assert.equal(f.reader.laneDiagnostics().waiting.database, 0);
    assert.equal(f.reader.laneDiagnostics().inFlight.database, 1, "the first worker operation still owns its slot");
    const abort = new AbortController();
    const cancelled = f.seam.read({ operation: "diagnostics" }, "database", false, 2_000, undefined, undefined, abort.signal);
    abort.abort();
    assert.equal(await cancelled, undefined, "an explicitly cancelled queued call settles immediately");
    assert.equal(firstFinished, false);
    const queuedWrite = f.reader.accessGadgetState(f.directory, f.directory, "storage",
      { operation: "set", key: [107], valueJson: "1", writeId: randomUUID() },
      { generation: "queued-generation", invocationId: "queued-invocation", expiresAt: Date.now() + 5_000 }, () => false);
    assert.equal(await f.reader.revokeGadgetGeneration("queued-generation"), true);
    assert.deepEqual(await queuedWrite, { kind: "error", error: "STALE_WRITE" });
    assert.equal(f.logged().some(row => row.operation === "gadgetState"), false, "revocation removes queued writes before dispatch");
    await first;
    console.log("PASS queue deadlines settle callers independently and remove expired work");
  } finally { await f.close(); }
}

async function maintenanceTimeoutKeepsExecution(): Promise<void> {
  const f = fixture("maintenance", { delayed: { deleteLibrary: 600 }, ignoreCancel: true });
  try {
    await f.reader.snapshots("warmup", 1);
    const write = { operation: "deleteLibrary", root: "/fixture", target: { kind: "item", id: "item-1" } };
    let unknown!: RuntimeAuditUnknownOperationError;
    await assert.rejects(f.seam.read(write, "maintenance", false, 200), error => {
      assert(error instanceof RuntimeAuditUnknownOperationError);
      unknown = error;
      return true;
    });
    const pending = f.reader.laneDiagnostics();
    assert.equal(pending.queued.maintenance, 0, "the caller has settled");
    assert.equal(pending.inFlight.maintenance, 1, "the real worker is still running");
    assert.equal(pending.unconfirmed.some(row => row.requestId === unknown.requestId), true);
    const running = await f.reader.queryOperation(unknown.requestId);
    assert.equal(running?.state, "running");
    assert.equal(f.reader.laneDiagnostics().inFlight.maintenance, 1, "a nonterminal receipt cannot release the slot");
    assert.equal(await f.seam.read({ operation: "libraryMetadata" }, "maintenance", false, 80), undefined);
    assert.equal(f.logged().some(row => row.operation === "libraryMetadata"), false, "work cannot pile behind an abandoned operation in Rust");
    assert.equal(await f.reader.snapshots("other-lane", 1), null, "a slow maintenance operation does not block a light read");
    await until(() => f.reader.laneDiagnostics().inFlight.maintenance === 0, "maintenance terminal reply");
    const complete = await f.reader.queryOperation(unknown.requestId);
    assert.equal(complete?.state, "committed");
    assert.deepEqual(complete?.result, { status: "deleted", itemIds: ["item-1"] });
    assert.equal(f.reader.laneDiagnostics().unconfirmed.length, 0);
    assert.equal(await f.seam.read({ operation: "libraryMetadata" }, "maintenance", false, 1_000), true);
    assert.equal(new Set(f.logged().map(row => row.pid)).size, 1, "timeouts never kill unrelated lanes");
    console.log("PASS maintenance unknown receipts retain real in-flight work and prevent hidden retries");
  } finally { await f.close(); }
}

async function revocationBypassesWriteQueue(): Promise<void> {
  const f = fixture("revoke", { delayed: { gadgetState: 400 } });
  try {
    const writing = f.reader.accessGadgetState(f.directory, f.directory, "storage",
      { operation: "set", key: [107], valueJson: "1", writeId: randomUUID() },
      { generation: "generation", invocationId: "invocation", expiresAt: Date.now() + 5_000 }, () => false);
    await until(() => f.logged().some(row => row.operation === "gadgetState" && row.stage === "started"), "gadget write start");
    assert.equal(await f.reader.revokeGadgetInvocation("generation", "invocation"), true);
    assert.equal(f.reader.laneDiagnostics().inFlight.database, 1, "revoke is acknowledged before the write finishes");
    assert.deepEqual(await writing, { kind: "error", error: "STALE_WRITE" });
    assert.throws(() => readFileSync(join(f.directory, "committed.json")), /ENOENT/, "revoked write did not publish state");
    console.log("PASS revocation control bypasses the write it cancels");
  } finally { await f.close(); }
}

async function databaseTimeoutKeepsInference(): Promise<void> {
  const f = fixture("inference-isolation", { hang: ["snapshots"], delayed: { semanticInference: 400 } });
  try {
    const inference = f.reader.semanticInference(f.model);
    await until(() => f.logged().some(row => row.operation === "semanticInference" && row.stage === "started"), "inference start");
    assert.equal(await f.seam.read({ operation: "snapshots" }, "database", false, 80), undefined);
    assert.deepEqual(await inference, { vector: [0.5, 0.25] });
    assert.equal(new Set(f.logged().map(row => row.pid)).size, 1);
    console.log("PASS a database caller timeout does not retire concurrent inference");
  } finally { await f.close(); }
}

async function correlationAndProtocol(): Promise<void> {
  const f = fixture("correlation", { misroute: ["snapshots"] });
  try {
    assert.equal(await f.reader.snapshots("fixture", 1), null);
    assert.equal(await f.reader.snapshots("fixture", 2), null);
    assert.equal(new Set(f.logged().map(row => row.pid)).size, 1);
  } finally { await f.close(); }
  const malformed = fixture("missing-id", { omitId: true });
  try {
    assert.equal(await malformed.reader.snapshots("fixture", 1), undefined, "uncorrelated replies are rejected by the current protocol");
  } finally { await malformed.close(); }
  const failedWrite = fixture("write-exit", { exit: ["deleteLibrary"] });
  try {
    await assert.rejects(failedWrite.seam.read({ operation: "deleteLibrary" }, "maintenance", false, 1_000),
      (error: unknown) => error instanceof RuntimeAuditUnknownOperationError && error.operation === "deleteLibrary");
  } finally { await failedWrite.close(); }
  console.log("PASS reply ids fence late messages and lost write replies remain unknown");
}

async function repeatedInferenceFailures(): Promise<void> {
  const f = fixture("repeated", { exit: ["semanticInference"] });
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal(await f.reader.semanticInference(f.model), undefined);
      if (i < 2) await f.reader.snapshots("restart", 1);
    }
    const before = f.logged().length;
    assert.equal(await f.reader.semanticInference(f.model), undefined);
    assert.equal(f.logged().length, before);
    console.log("PASS repeated inference-attributed failures stop new attempts");
  } finally { await f.close(); }
}

async function rejectedWritesCannotChangeWriter(): Promise<void> {
  const f = fixture("no-host-replay", { delayed: { snapshots: 500 } });
  let hostWrites = 0;
  const hostFallback = (value: unknown) => { if (value === undefined) hostWrites += 1; return value; };
  try {
    const first = f.seam.read({ operation: "snapshots" }, "database", false, 2_000);
    await until(() => f.logged().some(row => row.stage === "started"), "queue holder");
    await assert.rejects(f.seam.read({ operation: "writeProject" }, "database", false, 40).then(hostFallback),
      (error: unknown) => error instanceof RuntimeAuditNotStartedOperationError && error.reason === "expired-before-dispatch");
    const backlog = Array.from({ length: 255 }, () => f.seam.read({ operation: "diagnostics" }, "database", false, 2_000));
    await assert.rejects(f.seam.read({ operation: "writeProject" }, "database", false, 1_000).then(hostFallback),
      (error: unknown) => error instanceof RuntimeAuditNotStartedOperationError && error.reason === "overloaded");
    await assert.rejects(f.reader.supportsManagedStorage(),
      (error: unknown) => error instanceof RuntimeAuditNotStartedOperationError, "a dropped probe cannot advertise needsHost");
    assert.equal(hostWrites, 0, "a refused native write must not jump past pending writes through host fallback");
    await first;
    await Promise.all(backlog);
    assert.equal(await f.reader.supportsManagedStorage(), true, "a transient probe failure is not cached as unsupported or a rejected promise");
    assert.equal(f.logged().filter(row => row.operation === "writeProject").length, 0);
  } finally { await f.close(); }

  const probe = fixture("probe-timeout", { delayed: { managedStorageSupported: 200 } });
  try {
    await assert.rejects(probe.seam.read({ operation: "managedStorageSupported" }, "database", false, 70),
      (error: unknown) => error instanceof RuntimeAuditNotStartedOperationError);
    await until(() => probe.reader.laneDiagnostics().inFlight.database === 0, "probe terminal rejection");
    assert.equal(await probe.reader.supportsManagedStorage(), true);
    console.log("PASS overload, queue expiry and uncertain capability probes never trigger host writes");
  } finally { await probe.close(); }
}

async function controlOverloadFencesInsteadOfDropping(): Promise<void> {
  const f = fixture("control-overload", { delayed: { deleteLibrary: 1_000 }, holdControl: true, ignoreCancel: true });
  try {
    const writing = f.seam.read({ operation: "deleteLibrary" }, "maintenance", false, 2_000);
    const unknown = assert.rejects(writing, (error: unknown) => error instanceof RuntimeAuditUnknownOperationError);
    await until(() => f.logged().some(row => row.operation === "deleteLibrary" && row.stage === "started"), "write before control pressure");
    const replies = await Promise.all(Array.from({ length: 65 }, (_, index) => f.reader.revokeGadgetGeneration(`generation-${index}`)));
    assert(replies.every(value => value === false), "an unacknowledged revocation is never reported as successful");
    await unknown;
    assert.equal(f.reader.laneDiagnostics().inFlight.maintenance, 0, "a direct worker is retired instead of silently losing cancellation");
    assert.equal(f.logged().some(row => row.stage === "committed"), false);
    console.log("PASS exhausted control capacity retires the connection instead of dropping revocation");
  } finally { await f.close(); }
}

async function terminalReceiptsPreserveOutcomeTruth(): Promise<void> {
  const f = fixture("clipped-receipt", { holdReply: ["deleteLibrary"], omitReceiptResult: true });
  let hostWrites = 0;
  try {
    const writing = f.seam.read({ operation: "deleteLibrary" }, "maintenance", false, 2_000)
      .then(value => { if (value === undefined) hostWrites += 1; return value; });
    const unknown = assert.rejects(writing, (error: unknown) => error instanceof RuntimeAuditUnknownOperationError);
    await until(() => f.logged().some(row => row.stage === "committed"), "committed work with omitted receipt result");
    const requestId = f.logged().find(row => row.stage === "committed")!.requestId;
    const receipt = await f.reader.queryOperation(requestId);
    assert.equal(receipt?.state, "committed");
    assert.equal(receipt?.result, undefined);
    await unknown;
    assert.equal(hostWrites, 0, "a truncated receipt cannot return undefined into host fallback");
    assert.equal(f.reader.laneDiagnostics().inFlight.maintenance, 0, "confirmed commitment ends worker execution even when its result was omitted");
  } finally { await f.close(); }
  const failure = fixture("confirmed-failure", { fail: ["writeProject"] });
  try {
    await assert.rejects(failure.seam.read({ operation: "writeProject" }, "database", false, 1_000),
      (error: unknown) => error instanceof RuntimeAuditOperationFailedError
        && !(error instanceof RuntimeAuditNotStartedOperationError));
    assert.equal(failure.reader.laneDiagnostics().inFlight.database, 0);
    console.log("PASS omitted committed results remain explicit and executed failures are not called not-started");
  } finally { await failure.close(); }
}

async function recoveringFileReadsRemainMutations(): Promise<void> {
  let hostReads = 0;
  for (const operation of ["readGadgetSource", "readGadgetManifest", "captureBlueprintGadget"]) {
    const f = fixture(`recover-${operation}`, { delayed: { [operation]: 300 }, ignoreCancel: true });
    try {
      await f.reader.snapshots("warmup", 1);
      await assert.rejects(f.seam.read({ operation }, "database", false, 100).then(value => {
        if (value === undefined) hostReads += 1;
        return value;
      }), (error: unknown) => error instanceof RuntimeAuditUnknownOperationError && error.operation === operation);
      assert.equal(f.reader.laneDiagnostics().inFlight.database, 1, "source recovery may still be changing files after the caller times out");
    } finally { await f.close(); }
  }
  assert.equal(hostReads, 0, "a host read cannot race a native journal recovery whose result is unknown");
  console.log("PASS recovering Gadget reads keep unknown outcomes out of host fallback");
}

async function watchCleanupHasNoUnhandledRejection(): Promise<void> {
  const f = fixture("watch-cleanup", { delayed: { stopDotsFileWatch: 300 } });
  const unhandled: unknown[] = [];
  const recordUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", recordUnhandled);
  try {
    const watch = await f.reader.watchDotsFile(f.directory, "watched.txt", () => {}, () => {});
    assert(watch, "native watch was armed");
    watch.close();
    await f.reader.close();
    // Rejection reporting happens after the close promise resolves.
    await wait(20);
    assert.deepEqual(unhandled, [], "watch disposal during reader shutdown must handle its cleanup request");
    assert.equal(f.reader.laneDiagnostics().unconfirmed.length, 0, "ephemeral watch cleanup is not a persistent mutation");
    console.log("PASS watch disposal and reader shutdown leave no unhandled cleanup promise");
  } finally {
    await f.close();
    process.off("unhandledRejection", recordUnhandled);
  }
}

await deadlinesBeginAtEnqueue();
await maintenanceTimeoutKeepsExecution();
await revocationBypassesWriteQueue();
await databaseTimeoutKeepsInference();
await correlationAndProtocol();
await repeatedInferenceFailures();
await rejectedWritesCannotChangeWriter();
await controlOverloadFencesInsteadOfDropping();
await terminalReceiptsPreserveOutcomeTruth();
await recoveringFileReadsRemainMutations();
await watchCleanupHasNoUnhandledRejection();
