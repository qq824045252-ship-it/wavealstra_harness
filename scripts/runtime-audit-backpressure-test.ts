/**
 * Client admission counts both waiting callers and unfinished worker operations.
 *
 * Two properties are load bearing and used to be wrong:
 *   1. a request's budget starts when the caller asks, so a queued request cannot
 *      outlive its own budget while waiting behind a longer operation;
 *   2. the queue is bounded, so a stuck worker fails new requests fast instead of
 *      growing an unbounded backlog.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeAuditReader } from "../src/main/platform/runtime-audit";

const LF = String.fromCharCode(10);
const workerSource = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const hang = new Set([\"snapshots\"]);",
  'let buffered = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", chunk => {',
  "  buffered += chunk;",
  "  let index;",
  '  while ((index = buffered.indexOf(String.fromCharCode(10))) >= 0) {',
  "    const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);",
  "    if (!line.trim()) continue;",
  "    const request = JSON.parse(line);",
  '    fs.appendFileSync(path.join(__dirname, "requests.log"), JSON.stringify({ pid: process.pid, operation: request.operation }) + String.fromCharCode(10));',
  "    if (hang.has(request.operation)) continue;",
  '    process.stdout.write(JSON.stringify({ status: "ok", data: null, replyId: request.requestId }) + String.fromCharCode(10));',
  "  }",
  "});",
  "",
].join(LF);

const fixtures = join(process.cwd(), "out", "tests");
mkdirSync(fixtures, { recursive: true });
const directory = mkdtempSync(join(fixtures, "runtime-audit-backpressure-"));
const worker = join(directory, "fake-rust.cjs");
writeFileSync(worker, workerSource);
const reader = new RuntimeAuditReader(process.execPath, worker);

const observed = (operation: string): number => {
  try {
    return readFileSync(join(directory, "requests.log"), "utf8").trim().split(LF).filter(Boolean)
      .map(line => JSON.parse(line) as { operation: string })
      .filter(entry => entry.operation === operation).length;
  } catch { return 0; }
};

async function main(): Promise<void> {
  try {
    // Use the production entry point with short budgets; the fixture intentionally
    // ignores cancellation so unfinished worker work remains visible after timeout.
    const seam = reader as unknown as {
      read(request: object, lane: string, allowAfterInferenceFailure: boolean, timeoutMs: number): Promise<unknown>;
    };
    const startedAt = Date.now();
    const hung = seam.read({ operation: "snapshots", taskId: "fixture-task", limit: 1 }, "database", false, 800);
    await new Promise(resolve => setTimeout(resolve, 30));
    const backlog = Array.from({ length: 300 }, (_unused, index) =>
      seam.read({ operation: "diagnostics", taskId: "fixture-task", limit: 5, offset: index }, "database", false, 80));
    const initial = reader.laneDiagnostics();
    assert(initial.waiting.database + initial.inFlight.database <= 256, "worker and waiting work share the admission bound");
    assert(initial.totals.database.overloaded >= 40, "excess requests fail immediately");

    const results = await Promise.all(backlog);
    assert(results.every(entry => entry === undefined));
    assert(Date.now() - startedAt < 700, "queued callers settle before the earlier 800ms caller");
    assert.equal(observed("diagnostics"), 0, "expired queued requests never reach the worker");
    const drained = reader.laneDiagnostics();
    assert(drained.totals.database.expiredBeforeDispatch >= 250);
    assert.equal(drained.waiting.database, 0);
    assert.equal(drained.inFlight.database, 1, "the worker is not declared idle because other callers expired");
    assert.equal(drained.queued.database, 1, "only the first caller still awaits its own budget");

    assert.equal(await hung, undefined);
    const abandoned = reader.laneDiagnostics();
    assert.equal(abandoned.queued.database, 0);
    assert.equal(abandoned.inFlight.database, 1, "timeout is not a worker completion");
    assert.equal(await seam.read({ operation: "diagnostics" }, "database", false, 40), undefined);
    assert.equal(observed("diagnostics"), 0, "later callers cannot create a hidden Rust backlog");

    console.log("PASS independent enqueue deadlines, bounded admission and unfinished-worker accounting");
  } finally {
    await reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

void main();
