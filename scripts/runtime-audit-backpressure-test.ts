/**
 * The database lane is one serialized channel shared by light queries and long work.
 *
 * Two properties are load bearing and used to be wrong:
 *   1. a request's budget starts when the caller asks, so a queued request cannot
 *      double its wall-clock wait by waiting for its own timeout after the queue;
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
    // A stuck request owns the lane for its full 10s budget.
    const startedAt = Date.now();
    const hung = reader.snapshots("fixture-task", 1);
    // This one is accepted into the queue behind it and must not get a second budget.
    const queued = reader.snapshots("fixture-task", 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(reader.laneDiagnostics().queued.database, 2, "both requests are queued in the lane");

    // Backpressure: past the bound, requests fail immediately instead of queueing.
    const backlog = Array.from({ length: 300 }, (_unused, index) => reader.diagnostics("fixture-task", 5, index));
    assert(reader.laneDiagnostics().queued.database <= 256, "the lane never holds more than its bound");
    const rejected = reader.laneDiagnostics().totals.database.overloaded;
    assert(rejected >= 40, `excess requests must be rejected, saw ${rejected}`);
    assert.equal(reader.laneDiagnostics().recent.filter(entry => entry.outcome === "overloaded").length > 0, true);

    assert.equal(await hung, undefined, "the stuck request reports no result");
    const hungAt = Date.now();
    assert.equal(await queued, undefined, "the queued request reports no result");
    const queuedAt = Date.now();
    assert(queuedAt - hungAt < 2_000,
      `a queued request must not restart its budget after the queue (waited ${queuedAt - hungAt}ms)`);
    assert(queuedAt - startedAt < 16_000, "the queue hold is the stuck request's budget, not two budgets");

    const results = await Promise.all(backlog);
    assert(results.every(entry => entry === undefined), "an expired backlog never reaches the worker");
    assert.equal(observed("diagnostics"), 0, "queued-past-deadline requests are not dispatched");
    const totals = reader.laneDiagnostics().totals.database;
    assert(totals.expiredBeforeDispatch >= 200, `expired requests are accounted (${totals.expiredBeforeDispatch})`);
    assert.equal(reader.laneDiagnostics().queued.database, 0, "the lane drains back to zero");
    assert.equal(reader.laneDiagnostics().queued.inference, 0);
    assert.equal(reader.laneDiagnostics().queued.scan, 0);
    const drained = reader.laneDiagnostics().recent.at(-1)!;
    assert(["expired-before-dispatch", "timeout", "overloaded"].includes(drained.outcome));
    assert.equal(drained.lane, "database");
    console.log("PASS enqueue deadlines, bounded queue and drain accounting on the database lane");
  } finally {
    await reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

void main();
