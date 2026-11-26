import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { acquireCoreDatabaseGuard, connectCoreWorker, shutdownCoreWorker, type RuntimeCoreClient } from "../src/main/platform/core-client";
import { locateRuntimeAudit, RuntimeAuditReader } from "../src/main/platform/runtime-audit";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "The real Rust worker is required");
const tests = join(process.cwd(), "out", "tests"); mkdirSync(tests, { recursive: true });
const directory = mkdtempSync(join(tests, "core-client-"));
const dataDirectory = join(directory, "data"); mkdirSync(dataDirectory);
const database = join(directory, "app.db"); writeFileSync(database, "");
const historyPath = join(directory, "history.sqlite");
const history = new Database(historyPath);
history.exec("CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES(42)"); history.close();
const endpointPath = join(dataDirectory, "core.json");
const pids = new Set<number>();
const clients = new Set<RuntimeCoreClient>();
const readers = new Set<RuntimeAuditReader>();
const endpoint = (): { pid: number; workerPid: number; generation: string } => {
  const value = JSON.parse(readFileSync(endpointPath, "utf8"));
  pids.add(value.pid); pids.add(value.workerPid); return value;
};

async function within<T>(promise: Promise<T>, milliseconds = 4_000): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Error("Core client acceptance deadline exceeded");
  try { return await Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(timeout), milliseconds);
  })]); } finally { clearTimeout(timer!); }
}

async function open(): Promise<RuntimeCoreClient> {
  const client = await within(connectCoreWorker(executable!, database, { dataDirectory, timeoutMs: 4_000 }), 5_000);
  clients.add(client); endpoint(); return client;
}

async function close(client: RuntimeCoreClient): Promise<void> {
  if (client.exitCode !== null) { clients.delete(client); return; }
  const closed = new Promise<void>(resolve => client.once("close", resolve));
  client.kill(); await within(closed); clients.delete(client);
}

async function ping(client: RuntimeCoreClient): Promise<void> {
  const id = randomUUID(); let buffer = "";
  let consume: (chunk: Buffer) => void = () => {};
  const reply = new Promise<{ status?: string; data?: unknown }>((resolve, reject) => {
    consume = chunk => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) return;
        let value;
        try { value = JSON.parse(buffer.slice(0, newline)); } catch (error) { reject(error); return; }
        buffer = buffer.slice(newline + 1);
        if (value.replyId === id) { resolve(value); return; }
      }
    };
    client.stdout.on("data", consume);
    client.stdin.write(JSON.stringify({ operation: "nativeInferenceSupported", requestId: id, deadlineAt: Date.now() + 3_000 }) + "\n");
  });
  try {
    const value = await within(reply);
    assert.equal(value.status, "ok"); assert.equal(value.data, true);
  } finally { client.stdout.off("data", consume); }
}

try {
  const guard = await within(acquireCoreDatabaseGuard(executable!, dataDirectory));
  try {
    await assert.rejects(acquireCoreDatabaseGuard(executable!, dataDirectory), /ownership guard unavailable/);
    await assert.rejects(connectCoreWorker(executable!, database, { dataDirectory, timeoutMs: 250 }), /Core did not become available/);
    assert(!existsSync(endpointPath), "Core must not start during a guarded schema replacement");
  } finally { await within(guard.release()); }
  console.log("PASS database initialization guard excludes both a second initializer and Core startup");

  writeFileSync(endpointPath, "{}");
  const first = await open(); const a = endpoint(); await ping(first);
  await assert.rejects(acquireCoreDatabaseGuard(executable!, dataDirectory), /ownership guard unavailable/);
  await ping(first);
  await close(first);
  const second = await open(); await ping(second);
  assert.equal(endpoint().workerPid, a.workerPid, "disconnect must preserve the real worker");
  console.log("PASS production Core adapter recovers stale metadata and reconnects to the same worker");

  const abort = new AbortController();
  const aborted = connectCoreWorker(executable!, database, { dataDirectory, signal: abort.signal, timeoutMs: 4_000 });
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(within(aborted, 1_000), error => error instanceof Error && error.name === "AbortError");
  await ping(second); await close(second);
  console.log("PASS aborted competing connection leaves the active production client intact");

  // Sixteen is the real worker's snapshot cap. More reconnects prove abandoned
  // snapshots are released by the supervisor even when the UI omits snapshot.close.
  for (let index = 0; index < 18; index++) {
    const reader = new RuntimeAuditReader(executable!, database, { coreDataDirectory: dataDirectory }); readers.add(reader);
    const snapshot = await within(reader.openDurable(historyPath)); assert(snapshot, `snapshot ${index} must open via Core`);
    assert.equal((await within(snapshot.select("SELECT value FROM sample", [], true)) as { value: number }).value, 42);
    await within(reader.close()); readers.delete(reader);
  }
  assert.equal(endpoint().workerPid, a.workerPid);
  console.log("PASS RuntimeAuditReader production connection survives 18 UI lifetimes without leaking Durable snapshots");

  const beforeCrash = await open(); const old = endpoint();
  const disconnected = new Promise<void>(resolve => beforeCrash.once("close", resolve));
  process.kill(old.workerPid, "SIGKILL"); await within(disconnected); clients.delete(beforeCrash);
  const afterCrash = await open(); await ping(afterCrash);
  assert.notEqual(endpoint().generation, old.generation);
  await close(afterCrash);
  console.log("PASS production adapter discovers a new generation after an actual worker crash");

  await within(shutdownCoreWorker(dataDirectory, database), 6_000);
  assert(!existsSync(endpointPath));
  console.log("PASS explicit fixture shutdown releases the detached Core");

  const aliasDataDirectory = join(directory, "data-alias");
  symlinkSync(dataDirectory, aliasDataDirectory, process.platform === "win32" ? "junction" : "dir");
  const aliasDatabase = process.platform === "win32" ? join(directory, "APP.DB") : database;
  try {
    const startVia = async (dir: string, db: string) => {
      const client = await connectCoreWorker(executable!, db, { dataDirectory: dir, timeoutMs: 6_000 });
      clients.add(client);
      await ping(client);
      const active = JSON.parse(readFileSync(join(dir, "core.json"), "utf8")) as { pid: number; workerPid: number; generation: string };
      await close(client);
      return active;
    };
    const [canonicalEndpoint, aliasEndpoint] = await within(Promise.all([
      startVia(dataDirectory, database),
      startVia(aliasDataDirectory, aliasDatabase),
    ]), 8_000);
    assert.equal(aliasEndpoint.pid, canonicalEndpoint.pid);
    assert.equal(aliasEndpoint.workerPid, canonicalEndpoint.workerPid);
    assert.equal(aliasEndpoint.generation, canonicalEndpoint.generation);
    await assert.rejects(acquireCoreDatabaseGuard(executable!, aliasDataDirectory), /ownership guard unavailable/);
    console.log("PASS concurrent path-alias startup shares one Core owner and workerPid");
  } finally {
    if (existsSync(endpointPath)) { endpoint(); await within(shutdownCoreWorker(aliasDataDirectory, aliasDatabase), 6_000); }
    rmSync(aliasDataDirectory, { recursive: true, force: true });
  }

  const versionDirectory = join(directory, "versions"); mkdirSync(versionDirectory);
  const versionDatabase = join(versionDirectory, "app.db"); writeFileSync(versionDatabase, "");
  const updatableSource = join(directory, process.platform === "win32" ? "updatable-runtime.exe" : "updatable-runtime");
  copyFileSync(executable!, updatableSource);
  const versionOptions = { dataDirectory: versionDirectory, timeoutMs: 6_000 };
  let versionClient: RuntimeCoreClient | undefined;
  const recordVersion = () => {
    const value = JSON.parse(readFileSync(join(versionDirectory, "core.json"), "utf8"));
    pids.add(value.pid); pids.add(value.workerPid); return value;
  };
  try {
    versionClient = await within(connectCoreWorker(updatableSource, versionDatabase, versionOptions), 8_000);
    clients.add(versionClient); const old = recordVersion(); await ping(versionClient);
    // An executable image may carry an inert trailing overlay on Windows and Linux.
    // Changing the *source* while its shadow copy is running proves it is not locked.
    appendFileSync(updatableSource, "\nmybuddy-core-version-switch-fixture\n");
    await close(versionClient); versionClient = undefined;
    versionClient = await within(connectCoreWorker(updatableSource, versionDatabase, versionOptions), 8_000);
    clients.add(versionClient); const current = recordVersion(); await ping(versionClient);
    assert.notEqual(current.binaryHash, old.binaryHash);
    assert.notEqual(current.generation, old.generation);
    assert.notEqual(current.workerPid, old.workerPid);
    console.log("PASS replacing source executable leaves the running image intact and authenticated version switching retires the old owner");
  } finally {
    if (versionClient) await close(versionClient);
    if (existsSync(join(versionDirectory, "core.json"))) { recordVersion(); await within(shutdownCoreWorker(versionDirectory, versionDatabase), 6_000); }
  }

  const productionDirectory = join(directory, "production");
  const productionDatabase = join(productionDirectory, "app.db");
  const productionEndpoint = join(productionDirectory, "core.json");
  const options = { runtimeAuditExecutable: executable!, runtimeAuditSupervised: true };
  let app: AppDatabase | undefined;
  const recordProduction = () => {
    const value = JSON.parse(readFileSync(productionEndpoint, "utf8"));
    pids.add(value.pid); pids.add(value.workerPid); return value;
  };
  try {
    app = await within(AppDatabase.open(productionDatabase, options));
    assert.equal(app.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
    // First use includes publishing and hashing the immutable executable plus Core's
    // bounded 12-second startup. This is a lifecycle deadline, not a warm-query budget.
    const coldStarted = performance.now();
    assert.equal((await within(app.runtimeAuditReader!.queryOperation("production-connect"), 15_000))?.state, "unknown");
    console.log(`Core first production connection: ${Math.round(performance.now() - coldStarted)}ms`);
    const live = recordProduction();
    await within(app.runtimeAuditReader!.close()); app.close(); app = undefined;

    app = await within(AppDatabase.open(productionDatabase, options));
    assert.equal((await within(app.runtimeAuditReader!.queryOperation("production-reconnect")))?.state, "unknown");
    assert.equal(recordProduction().workerPid, live.workerPid);
    app.connection.exec("CREATE TABLE core_guard_sentinel(value TEXT); INSERT INTO core_guard_sentinel VALUES ('must survive')");
    app.connection.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION - 1}`);
    const original = statSync(productionDatabase);
    assert.throws(() => new AppDatabase(productionDatabase), /Core 独占锁/,
      "a CLI caller cannot bypass Core ownership by omitting native options");
    await assert.rejects(AppDatabase.open(productionDatabase, options), /ownership guard unavailable/);
    assert.equal(statSync(productionDatabase).ino, original.ino, "a live Core must protect the original database inode");
    const sentinel = app.connection.prepare("SELECT value FROM core_guard_sentinel").get() as { value: string };
    assert.equal(sentinel.value, "must survive");
    app.connection.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION}`);
    console.log("PASS production AppDatabase guarded creation and current-schema reconnect preserve Core; incompatible live schema is rejected before unlink");
  } finally {
    if (app) { await within(app.runtimeAuditReader!.close()); app.close(); }
    if (existsSync(productionEndpoint)) { recordProduction(); await within(shutdownCoreWorker(productionDirectory, productionDatabase), 6_000); }
  }
} finally {
  await Promise.allSettled([...readers].map(reader => within(reader.close())));
  await Promise.allSettled([...clients].map(close));
  try { if (existsSync(endpointPath)) { endpoint(); await within(shutdownCoreWorker(dataDirectory, database), 6_000); } } catch { /* exact owned PIDs below */ }
  try { const record = JSON.parse(readFileSync(join(dataDirectory, "core.lease"), "utf8")); pids.add(record.pid); } catch { /* released */ }
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
  await new Promise(resolve => setTimeout(resolve, 100));
  rmSync(directory, { recursive: true, force: true });
}
