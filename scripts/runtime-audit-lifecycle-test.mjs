#!/usr/bin/env node
/** Real-worker lifecycle contract: no mocked transport, no host write fallback. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';

const platform = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
const executable = process.env.MYBUDDY_TEST_RUNTIME_AUDIT_BIN || join(process.cwd(), 'out', 'native', platform, process.platform === 'win32' ? 'mybuddy-runtime-audit.exe' : 'mybuddy-runtime-audit');
assert(existsSync(executable), `missing real native worker: ${executable}`);
assert.equal(execFileSync(executable, ['--protocol-version'], { encoding: 'utf8', timeout: 5000 }).trim(), '89');
const root = mkdtempSync(join(tmpdir(), 'runtime-lifecycle-'));
const databasePath = join(root, 'app.db');
const database = new DatabaseSync(databasePath, { timeout: 1000 });
database.exec('PRAGMA journal_mode=WAL; CREATE TABLE work_host_lease (lease_id TEXT PRIMARY KEY,authority_id TEXT NOT NULL,acquired_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,released_at INTEGER)');
let runtime;
function start() {
  const child = spawn(executable, [databasePath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const end = stdout.indexOf('\n');
      const reply = JSON.parse(stdout.slice(0, end)); stdout = stdout.slice(end + 1);
      const entry = pending.get(reply.replyId);
      if (entry) { clearTimeout(entry.timer); pending.delete(reply.replyId); entry.resolve(reply); }
    }
  });
  const exited = once(child, 'exit');
  child.on('exit', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve({ status: 'process-exited' }); }
    pending.clear();
  });
  const call = (request, options = {}) => {
    const requestId = options.requestId || randomUUID();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`request timeout: ${request.operation}; ${stderr}`)); }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...request, requestId, deadlineAt: options.deadlineAt ?? Date.now() + 9000 }) + '\n');
    });
    return { requestId, reply };
  };
  return { child, exited, call, async close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; } };
}
const lease = (authorityId, action = 'acquire', now = Date.now()) => ({ operation: 'workHostLease', request: { action, authorityId, now, leaseTtlMs: 60000 } });
const control = (action, targetRequestId) => runtime.call({ operation: 'control', action, targetRequestId }).reply;
async function untilState(id, expected) {
  const end = Date.now() + 1000;
  while (Date.now() < end) {
    const reply = await control('status', id);
    if (reply.data?.state === expected) return reply.data;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`operation ${id} did not reach ${expected}`);
}
try {
  runtime = start();
  assert.equal((await runtime.call({ operation: 'historyLaneSupported' }).reply).data, true);
  const expired = await runtime.call(lease('must-not-acquire'), { deadlineAt: Date.now() - 1 }).reply;
  assert.equal(expired.status, 'expired'); assert.equal(expired.neverStarted, true);
  assert.equal(database.prepare('SELECT count(*) AS count FROM work_host_lease').get().count, 0);
  console.log('PASS expired admission has no database effect');

  database.exec('BEGIN IMMEDIATE');
  const blocker = runtime.call(lease('blocker'));
  const cancelled = runtime.call(lease('cancelled'));
  const expiresInQueue = runtime.call(lease('expired-queued'), { deadlineAt: Date.now() + 30 });
  const cancelAck = await control('cancel', cancelled.requestId);
  assert.equal(cancelAck.data.state, 'cancelled');
  assert.equal((await cancelled.reply).status, 'cancelled');
  assert.equal((await expiresInQueue.reply).status, 'expired');
  await blocker.reply;
  database.exec('ROLLBACK');
  assert.equal(database.prepare('SELECT count(*) AS count FROM work_host_lease').get().count, 0);
  console.log('PASS control cancellation remains live during a blocked writer and queued expiry does not execute');

  database.exec('BEGIN IMMEDIATE');
  const nativeLockOwner = runtime.call(lease('gate-blocker'));
  await untilState(nativeLockOwner.requestId, 'running');
  const maintenance = runtime.call({ operation: 'deleteLibrary', root, target: { kind: 'item', id: 'never-delete' } });
  await untilState(maintenance.requestId, 'running');
  assert.equal((await control('cancel', maintenance.requestId)).data.state, 'running',
    'running cancellation is a request until the transaction boundary refuses it');
  const maintenanceReply = await maintenance.reply;
  assert.equal(maintenanceReply.status, 'cancelled');
  assert.equal(maintenanceReply.neverStarted, false);
  await nativeLockOwner.reply;
  database.exec('ROLLBACK');
  assert.equal((await control('status', maintenance.requestId)).data.state, 'cancelled');
  console.log('PASS maintenance cancellation is rechecked after acquiring the shared write gate and before BEGIN');

  database.exec('BEGIN IMMEDIATE');
  const jobs = Array.from({ length: 160 }, () => runtime.call(lease('flood'), { deadlineAt: Date.now() + 250 }));
  const probeStart = performance.now();
  const ping = await runtime.call({ operation: 'control', action: 'status', targetRequestId: jobs[0].requestId }).reply;
  assert.equal(ping.status, 'ok');
  assert(performance.now() - probeStart < 1000, 'control must not wait for saturated business queues');
  const probe = runtime.call({ operation: 'historyLaneSupported' });
  const release = setTimeout(() => { if (database.isTransaction) database.exec('ROLLBACK'); }, 400);
  const replies = await Promise.all(jobs.map(job => job.reply));
  clearTimeout(release); if (database.isTransaction) database.exec('ROLLBACK');
  assert(replies.some(reply => reply.errorCode === 'OVERLOADED' && reply.neverStarted === true));
  // A probe can be explicitly overloaded while the input admission queue is full;
  // after the burst, the read lane must recover without restarting the worker.
  await probe.reply;
  assert.equal((await runtime.call({ operation: 'historyLaneSupported' }).reply).data, true);
  console.log('PASS bounded queues reject overload and preserve the independent control/read paths');

  database.exec('DELETE FROM work_host_lease');
  const committed = runtime.call(lease('confirmed'));
  assert.equal((await committed.reply).data.ok, true);
  assert.equal((await control('status', committed.requestId)).data.state, 'committed');
  const committedId = committed.requestId;
  database.exec('BEGIN IMMEDIATE');
  const interrupted = runtime.call(lease('confirmed', 'heartbeat'));
  await untilState(interrupted.requestId, 'running');
  await runtime.close();
  database.exec('ROLLBACK');
  runtime = start();
  const restored = await control('status', committedId);
  assert.equal(restored.data.state, 'committed');
  assert.equal(restored.data.result.ok, true);
  const unknown = await control('status', interrupted.requestId);
  assert.equal(unknown.data.state, 'unknown');
  const retry = await runtime.call(lease('must-not-replay'), { requestId: interrupted.requestId }).reply;
  assert.equal(retry.errorCode, 'DUPLICATE_REQUEST');
  assert.equal(retry.neverStarted, false, 'duplicate rejection must not license a host replay of an unknown effect');
  assert.equal(database.prepare('SELECT authority_id FROM work_host_lease').get().authority_id, 'confirmed');
  console.log('PASS terminal receipts survive restart and uncertain writes cannot replay under the same request ID');
} finally {
  if (database.isTransaction) database.exec('ROLLBACK');
  await runtime?.close(); database.close(); rmSync(root, { recursive: true, force: true });
}
