import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { WorkHostAuthority, type RuntimeWorkHostLeaseRequest,
  type WorkHostLeaseWriter } from "../src/main/agent/work/WorkHostAuthority";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const directory = mkdtempSync(join(tmpdir(), "mybuddy-host-authority-"));
const native = process.argv.includes("--native");

async function verifyHostLockDoesNotBlock(): Promise<void> {
  const path = join(directory, "host-only.db");
  const db = new AppDatabase(path);
  const other = new Database(path);
  const authority = new WorkHostAuthority(db.connection, "host-only");
  try {
    assert(authority.start().ok);
    other.exec("BEGIN IMMEDIATE");
    const before = performance.now();
    assert.equal(authority.heartbeat(), false, "busy ownership is not renewed");
    assert(performance.now() - before < 250, "a busy synchronous fallback fails promptly, without the default five-second wait");
    assert.equal(db.connection.pragma("busy_timeout", { simple: true }), 5_000, "temporary nonblocking scope restores the connection policy");
    other.exec("ROLLBACK");
    assert(authority.heartbeat());
  } finally {
    if (other.inTransaction) other.exec("ROLLBACK");
    authority.stop();
    other.close();
    db.close();
  }
  console.log("PASS Work host-only lease never blocks the main loop on SQLite contention");
}

async function verifyNativeAuthorityLifecycle(): Promise<void> {
  let now = 1_000;
  let fail = false;
  let releaseFirst!: () => void;
  const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  const calls: RuntimeWorkHostLeaseRequest[] = [];
  let first = true;
  const writer: WorkHostLeaseWriter = {
    async workHostLease(request) {
      calls.push(request);
      if (first) { first = false; await blocked; }
      if (fail) throw new Error("unknown lease reply");
      return { ok: true, authorityId: request.authorityId, holderAuthorityId: request.authorityId,
        acquiredAt: 1_000, heartbeatAt: request.now, releasedAt: request.action === "release" ? request.now : null };
    },
  };
  // Any synchronous database access in the native ownership path is a regression.
  const forbidden = new Proxy({}, { get() { throw new Error("native ownership touched the host database"); } }) as Database.Database;
  const authority = new WorkHostAuthority(forbidden, "native-owner", 600, () => now, writer);
  let recoveries = 0;
  authority.onAcquired(() => { recoveries += 1; });
  assert.equal(authority.start().ok, false, "ownership is not guessed while the writer is pending");
  await delay(10);
  assert.equal(authority.isAuthority(), false);
  authority.stop();
  releaseFirst();
  await authority.flush();
  assert.equal(authority.isAuthority(), false, "a late acquire reply cannot resurrect a stopped host");
  assert.equal(recoveries, 0, "startup catch-up cannot run on a pending or retired acquisition");
  assert.deepEqual(calls.map(call => call.action), ["acquire", "release"]);

  authority.start();
  await authority.flush();
  assert(authority.isAuthority());
  assert.equal(recoveries, 1, "deferred startup work runs after actual ownership arrives");
  fail = true;
  authority.heartbeat();
  await authority.flush();
  assert.equal(authority.isAuthority(), false, "an unknown renewal fails closed without a host write fallback");
  fail = false;
  authority.acquire();
  await authority.flush();
  assert(authority.isAuthority());
  assert.equal(recoveries, 2, "ownership recovery retriggers work skipped during a failed renewal");
  now += 601;
  assert.equal(authority.isAuthority(), false, "the cache cannot outlive the persisted lease's TTL");
  authority.stop();
  await authority.flush();
  console.log("PASS asynchronous authority: pending, late reply, unknown outcome, expiry and release fencing");
}

async function verifyRealRustWriter(): Promise<void> {
  const executable = locateRuntimeAudit(process.cwd());
  assert(executable && existsSync(executable), "native Work ownership requires the real Rust worker");
  const path = join(directory, "native.db");
  const db = new AppDatabase(path, { runtimeAuditExecutable: executable });
  const reader = db.runtimeAuditReader!;
  const authority = new WorkHostAuthority(db.connection, "rust-owner", 60_000, () => Date.now(), reader);
  let worker: Worker | undefined;
  try {
    db.connection.pragma("query_only = ON");
    authority.start();
    await authority.flush();
    assert(authority.isAuthority(), "Rust acquires even when host writes are forbidden");
    const workerSource = `const {workerData,parentPort}=require('node:worker_threads');
      const Database=require(workerData.driver); const db=new Database(workerData.path);
      db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');
      parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});`;
    worker = new Worker(workerSource, { eval: true, workerData: { path, driver: createRequire(import.meta.url).resolve("better-sqlite3") } });
    await once(worker, "message");
    const start = performance.now();
    authority.heartbeat();
    await delay(10);
    assert(performance.now() - start < 300, "Rust lock contention does not freeze the Node event loop");
    await authority.flush();
    assert.equal(authority.isAuthority(), false, "a failed renewal does not extend authority");
    const exited = once(worker, "exit");
    worker.postMessage("release");
    await exited;
    worker = undefined;
    authority.acquire();
    await authority.flush();
    assert(authority.isAuthority(), "ownership recovers after the writer lock is released");
  } finally {
    if (worker) await worker.terminate();
    authority.stop();
    await authority.flush();
    await reader.close();
    db.close();
  }
  console.log("PASS native Work ownership: Rust-only write, real lock contention, responsive main loop and recovery");
}

try {
  await verifyHostLockDoesNotBlock();
  await verifyNativeAuthorityLifecycle();
  if (native) await verifyRealRustWriter();
} finally {
  rmSync(directory, { recursive: true, force: true });
}
