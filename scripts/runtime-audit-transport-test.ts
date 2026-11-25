/**
 * Fault injection for the TypeScript side of the resident Rust transport.
 *
 * The "Rust" worker here is a script executed by the same Node binary, so the
 * reader spawns it exactly as it spawns the real worker: spawn(executable, [path]).
 * Every spawned process re-reads its behaviour from a config file, which lets a
 * test fail one generation and then succeed the next without touching the reader.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeAuditReader, type RuntimeSemanticModel } from "../src/main/platform/runtime-audit";

const serverSource = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const directory = __dirname;",
  "let config = {};",
  'try { config = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")); } catch {}',
  "const hang = new Set(config.hang || []);",
  "const exitOn = new Set(config.exit || []);",
  'const misroute = new Set(config.misroute || []);',
  'const delayed = new Map(Object.entries(config.delayed || {}));',
  'const inferenceLane = new Set(["semanticInference", "semanticModelProbe", "stageEmbedding"]);',
  'const maintenanceLane = new Set(["cleanupArtifactFiles", "deleteLibrary", "drainLibraryCleanup",',
  '  "exportLibraryBackup", "prepareLibraryRestore", "discardLibraryRestore", "restoreLibraryBackup",',
  '  "recoverLibraryRestores", "deleteProject", "promoteProjectEventToLibrary"]);',
  "const data = {",
  "  nativeInferenceSupported: true, nativeEmbeddingIndexSupported: true,",
  '  semanticInference: { vector: [0.5, 0.25] }, semanticModelProbe: { status: "ready" },',
  '  stageEmbedding: "staged", libraryMetadata: true,',
  '  deleteLibrary: { status: "deleted", itemIds: [] },',
  "};",
  "function note(request) {",
  '  fs.appendFileSync(path.join(directory, "requests.log"), JSON.stringify({ pid: process.pid, operation: request.operation, requestId: request.requestId ?? null }) + "\\n");',
  "}",
  "function reply(request, value) {",
  '  const payload = { status: "ok", data: value };',
  '  if (request.requestId !== undefined && !config.legacy) payload.replyId = request.requestId;',
  "  if (inferenceLane.has(request.operation)) payload.inference = true;",
  "  if (maintenanceLane.has(request.operation)) payload.maintenance = true;",
  '  process.stdout.write(JSON.stringify(payload) + "\\n");',
  "}",
  'const value = operation => Object.prototype.hasOwnProperty.call(data, operation) ? data[operation] : null;',
  'let buffered = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", chunk => {',
  "  buffered += chunk;",
  "  let index;",
  '  while ((index = buffered.indexOf("\\n")) >= 0) {',
  "    const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);",
  "    if (!line.trim()) continue;",
  "    let request;",
  "    try { request = JSON.parse(line); } catch { process.exit(2); }",
  "    const operation = request.operation;",
  "    note(request);",
  "    if (exitOn.has(operation)) process.exit(3);",
  "    if (hang.has(operation)) continue;",
  "    if (misroute.has(operation)) {",
  '      process.stdout.write(JSON.stringify({ status: "ok", data: { stray: true }, replyId: "stale-reply" }) + "\\n");',
  "    }",
  "    // A late reply: the caller's budget can expire before this arrives. Delayed once",
  "    // per operation so the lane can be proven to recover without slowing the run.",
  "    const wait = delayed.get(operation);",
  '    if (typeof wait === "number") {',
  "      delayed.delete(operation);",
  "      setTimeout(() => reply(request, value(operation)), wait);",
  "      continue;",
  "    }",
  "    reply(request, value(operation));",
  "  }",
  "});",
  'process.stdin.on("end", () => process.exit(0));',
  "",
].join("\n");

interface LoggedRequest { pid: number; operation: string; requestId: string | null }

const fixtures = join(process.cwd(), "out", "tests");
mkdirSync(fixtures, { recursive: true });

/** One reader per scenario: a live worker keeps its startup behaviour, so scenarios do not share one. */
function createFixture(name: string) {
  const directory = mkdtempSync(join(fixtures, `runtime-audit-${name}-`));
  const worker = join(directory, "fake-rust.cjs");
  const logPath = join(directory, "requests.log");
  writeFileSync(worker, serverSource);
  const model: RuntimeSemanticModel = {
    libraryPath: join(directory, "onnxruntime.dll"), modelPath: join(directory, "model.onnx"),
    tokenizerPath: join(directory, "tokenizer.json"), dimension: 2,
  };
  const configured = (behaviour: object): void => {
    writeFileSync(join(directory, "config.json"), JSON.stringify(behaviour));
  };
  const logged = (): LoggedRequest[] => {
    try {
      return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as LoggedRequest);
    } catch { return []; }
  };
  const reader = new RuntimeAuditReader(process.execPath, worker);
  return {
    model, reader, logged, configured,
    inferenceRequests: () => logged().filter(entry => entry.operation === "semanticInference"),
    close: async () => { await reader.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

/** Slack so a hung request is provably in the reader's pending slot before the next step. */
const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // 1-2. A database timeout retires the shared worker while inference is in flight.
  const recovery = createFixture("recovery");
  try {
    recovery.configured({ hang: ["snapshots", "semanticInference"] });
    const interrupted = recovery.reader.semanticInference(recovery.model);
    await settle();
    assert.equal(recovery.inferenceRequests().length, 1, "the inference request reached the worker");
    assert.match(recovery.inferenceRequests()[0]!.requestId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-/,
      "the inference request carries a transport id");
    const stalledPid = recovery.inferenceRequests()[0]!.pid;
    // The database lane times out after its 10s budget and stops the whole process.
    assert.equal(await recovery.reader.snapshots("fixture-task", 5), undefined);
    assert.equal(await interrupted, undefined, "in-flight inference reports an unknown result");
    console.log("PASS database timeout retires the worker while inference is in flight");

    recovery.configured({});
    assert.deepEqual(await recovery.reader.semanticInference(recovery.model), { vector: [0.5, 0.25] },
      "inference recovers after an unrelated restart");
    const requests = recovery.inferenceRequests();
    assert.equal(requests.length, 2, "the retry is a real request, not a cached failure");
    assert.notEqual(requests[1]!.pid, stalledPid, "the retry runs in the restarted worker");
    console.log("PASS inference is re-armed after a database-caused restart");
  } finally {
    await recovery.close();
  }

  // 3. A worker that keeps dying on inference is not spawned forever. Ordinary
  //    database traffic restarts the worker between attempts, exactly as it does in the app.
  const repeated = createFixture("repeated");
  try {
    repeated.configured({ exit: ["semanticInference"] });
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(await repeated.reader.semanticInference(repeated.model), undefined,
        "a worker that dies on inference returns no result");
      if (attempt < 2) await repeated.reader.snapshots("fixture-task", 1);
    }
    assert.equal(repeated.inferenceRequests().length, 3, "every failure was a real attempt");
    repeated.configured({});
    const before = repeated.logged().length;
    assert.equal(await repeated.reader.semanticInference(repeated.model), undefined,
      "repeated failures stop new attempts");
    assert.equal(repeated.logged().length, before, "blocked inference sends nothing to the worker");
    console.log("PASS repeated inference failures stop new attempts instead of looping");
  } finally {
    await repeated.close();
  }

  // 4. A reply that names no in-flight request is a late arrival, not a protocol fault:
  //    the pending request keeps its own reply and the worker is never retired.
  const correlation = createFixture("correlation");
  try {
    correlation.configured({ misroute: ["snapshots"] });
    assert.equal(await correlation.reader.snapshots("fixture-task", 1), null,
      "the correlated reply settles the request, the misaddressed one is dropped");
    assert.equal(await correlation.reader.snapshots("fixture-task", 2), null);
    const requests = correlation.logged();
    assert.equal(requests.length, 2);
    assert.equal(new Set(requests.map(entry => entry.pid)).size, 1, "a stray reply must not retire the worker");
    assert.equal(new Set(requests.map(entry => entry.requestId)).size, 2, "every request carries its own id");
    console.log("PASS a reply with an unknown id is dropped and leaves the worker running");
  } finally {
    await correlation.close();
  }

  // 5. A worker that echoes no id is still served: its reply is placed by the lane it declares.
  const legacy = createFixture("legacy");
  try {
    legacy.configured({ legacy: true });
    assert.deepEqual(await legacy.reader.semanticInference(legacy.model), { vector: [0.5, 0.25] },
      "an id-less reply still settles the request waiting on its lane");
    console.log("PASS a reply without an id still settles its lane request");
  } finally {
    await legacy.close();
  }

  // 6. A long maintenance job owns its own lane: a light query settles while the
  //    deletion is still running, so the two never share one client-side queue.
  const isolation = createFixture("isolation");
  isolation.configured({ hang: ["deleteLibrary"] });
  const deletion = isolation.reader.deleteLibrary("/library", { kind: "item", id: "item-1" });
  try {
    await settle();
    assert.equal(isolation.reader.laneDiagnostics().queued.maintenance, 1,
      "the long job is counted on the maintenance lane");
    assert.equal(isolation.reader.laneDiagnostics().queued.database, 0,
      "no light query is queued behind it");
    assert.equal(await isolation.reader.snapshots("fixture-task", 5), null,
      "a light query settles while the maintenance job is still in flight");
    const lanes = isolation.reader.laneDiagnostics();
    assert.equal(lanes.recent.some(entry => entry.lane === "database" && entry.operation === "snapshots"
      && entry.outcome === "completed"), true, "the light query completed on the database lane");
    assert.equal(lanes.totals.maintenance.completed, 0, "the deletion has not completed yet");
    assert.equal(lanes.queued.maintenance, 1, "the deletion is still in flight");
    console.log("PASS a maintenance job does not block light queries in the client");
  } finally {
    await isolation.close();
    assert.equal(await deletion, undefined, "a retired worker settles the pending maintenance request");
    assert.equal(isolation.reader.laneDiagnostics().queued.maintenance, 0,
      "the maintenance lane drains back to zero");
  }

  // 7. A maintenance timeout resolves the caller, keeps the session **and** releases the
  //    lane: the worker may still finish the abandoned job, but one slow restore must not
  //    wedge every later library/project write for the rest of the session.
  const lateReply = createFixture("maintenance-timeout");
  try {
    lateReply.configured({ delayed: { deleteLibrary: 700 } });
    // Narrow seam: the same lane entry point the public methods use, with a short budget
    // instead of its 120s production one, so the timeout is observable without the wait.
    const laneRead = (request: object, timeoutMs: number) =>
      (lateReply.reader as unknown as {
        read(request: object, lane: string, allowAfterInferenceFailure: boolean, timeoutMs: number): Promise<unknown>;
      }).read(request, "maintenance", false, timeoutMs);
    const deletion = { operation: "deleteLibrary", root: "/library", target: { kind: "item", id: "item-1" } };
    const startedAt = Date.now();
    assert.equal(await laneRead(deletion, 250), undefined, "the caller gives up with no result");
    assert(Date.now() - startedAt < 1_500, "the seam waits its own short budget");
    const expired = lateReply.reader.laneDiagnostics();
    assert.equal(expired.totals.maintenance.timedOut, 1, "the timeout is accounted on the new lane");
    assert.equal(expired.queued.maintenance, 0, "the caller is no longer queued");

    // The abandoned job is still running in the worker, but it no longer holds the lane.
    assert.deepEqual(await laneRead(deletion, 5_000), { status: "deleted", itemIds: [] },
      "a timed-out maintenance job does not block the next one");
    const afterRetry = lateReply.reader.laneDiagnostics();
    assert.equal(afterRetry.totals.maintenance.completed, 1, "the retry completed");
    assert.equal(afterRetry.totals.maintenance.slotBusy, 0, "the abandoned job no longer holds a slot");
    assert.equal(lateReply.logged().filter(entry => entry.operation === "deleteLibrary").length, 2,
      "the retry really reached the worker");

    await settle(700);
    const settled = lateReply.reader.laneDiagnostics();
    assert.equal(settled.recent.filter(entry => entry.operation === "deleteLibrary" && entry.outcome === "completed").length, 1,
      "the reply that arrives after the caller gave up is dropped, not applied");
    assert.equal(settled.queued.maintenance, 0, "the maintenance lane drains back to zero");
    assert.deepEqual(await lateReply.reader.snapshots("fixture-task", 1), null,
      "a database request still works after a maintenance timeout");
    const pids = new Set(lateReply.logged().map(entry => entry.pid));
    assert.equal(pids.size, 1, "a maintenance timeout must not retire the shared worker");
    console.log("PASS a maintenance timeout keeps the session, releases the lane and drops the late reply");
  } finally {
    await lateReply.close();
  }
}

await main();
