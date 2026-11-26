/**
 * Wave 4 Acceptance Suite (`T21`, `T22`):
 * - T21: Data correctness under readonly DB, SQLite BUSY lock contention,
 *        corrupt/non-SQLite bytes, and abnormal Core worker SIGKILL crash.
 *        Proves Core never deletes valid DBs, never misclassifies I/O errors
 *        as schema incompatibility, and never fakes success.
 * - T22: Managed process-tree termination & TCP port / file-handle release on
 *        cancel (`service.stop()` / `runtime.stop()`) across Node grandchild tree,
 *        Python process backend (or explicit BLOCKED if unavailable), and missing runtime.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetService } from "../src/main/gadget/GadgetService";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function discardedBackups(dbPath: string): string[] {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.startsWith(`${basename(dbPath)}.discarded-`)).sort();
}

function setReadOnlyFlag(file: string, readonly: boolean): void {
  if (!existsSync(file)) return;
  chmodSync(file, readonly ? 0o444 : 0o666);
  if (process.platform === "win32") {
    try {
      execFileSync("attrib", [readonly ? "+R" : "-R", file], { windowsHide: true });
    } catch { /* best effort */ }
  }
}

async function canConnectTcp(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const sock = netConnect(port, "127.0.0.1");
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
  });
}

async function canBindPort(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

function findExecutable(cmd: string): string | undefined {
  if (process.platform === "win32") {
    for (const query of [`${cmd}.exe`, cmd]) {
      const res = spawnSync("where.exe", [query], { encoding: "utf8", windowsHide: true });
      if (res.status === 0 && res.stdout) {
        const candidates = res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const preferred = candidates.find(c => /\.exe$/i.test(c))
          ?? candidates.find(c => /\.(?:cmd|bat)$/i.test(c))
          ?? candidates[0];
        if (preferred) return preferred;
      }
    }
    return undefined;
  }
  const r = spawnSync("which", [cmd], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : undefined;
}

function hasCommand(cmd: string, args: string[]): boolean {
  const exe = findExecutable(cmd) ?? cmd;
  const r = spawnSync(exe, args, { stdio: "ignore", windowsHide: true, shell: /\.(?:cmd|bat)$/i.test(exe) });
  return r.error === undefined && r.status === 0;
}

async function runT21DataCorrectness(exe: string, root: string): Promise<void> {
  // T21a: Readonly filesystem / read-only DB file must reject writes without deleting DB or creating discarded backups.
  {
    const dirA = join(root, "t21a", ".mybuddy");
    const dbPathA = join(dirA, "app.db");
    const wsDir = join(root, "t21a", "ws");
    mkdirSync(wsDir, { recursive: true });
    await initializeCoreDatabase(exe, dirA, dbPathA, CURRENT_DATABASE_SCHEMA_VERSION);

    let db = await AppDatabase.open(dbPathA, { runtimeAuditExecutable: exe, runtimeAuditSupervised: true, readonly: true });
    await db.writeWorkspaceUpsert({ id: "t21a-space", name: "T21a", path: wsDir });
    await db.writeTaskRecord({ id: "t21-keep", title: "Must Survive Readonly", spaceId: "t21a-space", cwd: wsDir, updatedAt: Date.now() });
    await db.runtimeAuditReader?.close();
    db.close();
    await shutdownCoreWorker(dirA, dbPathA);

    for (const suffix of ["", "-wal", "-shm"]) setReadOnlyFlag(`${dbPathA}${suffix}`, true);
    let clientA: CoreBusinessClient | undefined;
    try {
      clientA = await CoreBusinessClient.connect(exe, dbPathA, { dataDirectory: dirA, role: "background-service", clientId: "t21a-bg" });
      await assert.rejects(
        () => clientA!.upsertNote({ commandId: "t21a-cmd", entityId: "t21a-note", title: "Should Fail Readonly" }),
        (err: unknown) => err instanceof Error,
        "T21a: mutating write against read-only DB must reject loudly",
      );
      await clientA.close();
      clientA = undefined;
      await shutdownCoreWorker(dirA, dbPathA);
    } finally {
      await clientA?.close().catch(() => undefined);
      await shutdownCoreWorker(dirA, dbPathA).catch(() => undefined);
      for (const suffix of ["", "-wal", "-shm"]) setReadOnlyFlag(`${dbPathA}${suffix}`, false);
    }

    assert(existsSync(dbPathA), "T21a: valid DB must NOT be deleted on readonly I/O error");
    assert.deepEqual(discardedBackups(dbPathA), [], "T21a: zero .discarded-* backups permitted");
    const verify = new Database(dbPathA, { readonly: true, fileMustExist: true });
    try {
      const row = verify.prepare("SELECT title FROM tasks WHERE id = ?").get("t21-keep") as { title: string } | undefined;
      assert.equal(row?.title, "Must Survive Readonly", "T21a: existing sentinel row must survive intact");
      assert.equal(verify.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      verify.close();
    }
    console.log("[Wave4] PASS T21a: readonly DB fault fails honestly, preserves valid DB & sentinel row");
  }

  // T21b: External SQLite DB BUSY exclusive lock must not fake commit and recovers cleanly after unlock.
  {
    const dirB = join(root, "t21b", ".mybuddy");
    const dbPathB = join(dirB, "app.db");
    mkdirSync(dirB, { recursive: true });
    await initializeCoreDatabase(exe, dirB, dbPathB, CURRENT_DATABASE_SCHEMA_VERSION);

    let bgNormal: CoreBusinessClient | undefined;
    let bgBusy: CoreBusinessClient | undefined;
    const extDb = new Database(dbPathB, { fileMustExist: true });
    try {
      // Connect warm Core first so startup does not share the 300ms BUSY RPC deadline.
      bgNormal = await CoreBusinessClient.connect(exe, dbPathB, {
        dataDirectory: dirB,
        role: "background-service",
        clientId: "t21b-ok",
        timeoutMs: 5_000,
      });
      extDb.exec("BEGIN EXCLUSIVE");
      bgBusy = await CoreBusinessClient.connect(exe, dbPathB, {
        dataDirectory: dirB,
        role: "ui",
        clientId: "t21b-busy",
        timeoutMs: 300,
      });
      await assert.rejects(
        () => bgBusy!.upsertNote({ commandId: "t21b-busy-cmd", entityId: "t21b-busy-note", title: "Blocked By Busy Lock" }),
        (err: unknown) => err instanceof Error,
        "T21b: DB BUSY exclusive lock must reject rather than faking commit",
      );
      await bgBusy.close();
      bgBusy = undefined;
      extDb.exec("ROLLBACK");
      extDb.close();

      const res = await bgNormal.upsertNote({ commandId: "t21b-ok-cmd", entityId: "t21b-ok-note", title: "Committed After Unlock" });
      assert.equal(res.status, "committed");
      assert.deepEqual(discardedBackups(dbPathB), []);
    } finally {
      try { if (extDb.open) { try { extDb.exec("ROLLBACK"); } catch { /* ignore */ } extDb.close(); } } catch { /* ignore */ }
      await bgBusy?.close().catch(() => undefined);
      await bgNormal?.close().catch(() => undefined);
      await shutdownCoreWorker(dirB, dbPathB).catch(() => undefined);
    }
    console.log("[Wave4] PASS T21b: SQLite DB BUSY lock fails honestly without faking success & recovers post-unlock");
  }

  // T21c: Corrupt/unreadable non-SQLite bytes must NOT be misclassified as old schema or deleted.
  {
    const dirC = join(root, "t21c", ".mybuddy");
    const dbPathC = join(dirC, "app.db");
    mkdirSync(dirC, { recursive: true });
    const rawCorrupt = Buffer.from("NOT_A_SQLITE_FILE_T21_CORRUPT_SENTINEL");
    writeFileSync(dbPathC, rawCorrupt);
    await assert.rejects(
      () => initializeCoreDatabase(exe, dirC, dbPathC, CURRENT_DATABASE_SCHEMA_VERSION),
      (err: unknown) => err instanceof Error,
      "T21c: unreadable non-SQLite bytes must be rejected, never wiped as old schema",
    );
    assert.deepEqual(readFileSync(dbPathC), rawCorrupt, "T21c: original bytes must remain untouched");
    assert.deepEqual(discardedBackups(dbPathC), []);
    console.log("[Wave4] PASS T21c: corrupt non-SQLite bytes preserved without false old-schema deletion");
  }

  // T21d: Abnormal Core worker SIGKILL crash retains committed data and passes integrity_check.
  {
    const dirD = join(root, "t21d", ".mybuddy");
    const dbPathD = join(dirD, "app.db");
    mkdirSync(dirD, { recursive: true });
    await initializeCoreDatabase(exe, dirD, dbPathD, CURRENT_DATABASE_SCHEMA_VERSION);
    let clientD: CoreBusinessClient | undefined;
    try {
      clientD = await CoreBusinessClient.connect(exe, dbPathD, { dataDirectory: dirD, role: "background-service", clientId: "t21d-bg" });
      const committed = await clientD.upsertNote({ commandId: "t21d-keep-cmd", entityId: "t21d-crash-keep", title: "Survives SIGKILL" });
      assert.equal(committed.status, "committed");
      const beforeJson = JSON.parse(readFileSync(join(dirD, "core.json"), "utf8")) as { workerPid: number };
      const killedPid = beforeJson.workerPid;
      assert(killedPid > 0);

      process.kill(killedPid, "SIGKILL");
      await until(() => !alive(killedPid), "T21d killed worker exited", 10_000);
      await clientD.close().catch(() => undefined);
      clientD = undefined;

      await until(async () => {
        try {
          const c = await CoreBusinessClient.connect(exe, dbPathD, { dataDirectory: dirD, role: "background-service", clientId: "t21d-rec", timeoutMs: 3_000 });
          try {
            const snap = await c.eventsSnapshot("domainNote");
            return c.workerPid !== killedPid && snap.notes.some(n => n.entityId === "t21d-crash-keep" && n.title === "Survives SIGKILL");
          } finally {
            await c.close().catch(() => undefined);
          }
        } catch {
          return false;
        }
      }, "T21d Core recovers after worker SIGKILL & preserves committed sentinel note", 15_000);
    } finally {
      await clientD?.close().catch(() => undefined);
      await shutdownCoreWorker(dirD, dbPathD).catch(() => undefined);
    }
    const verify = new Database(dbPathD, { readonly: true, fileMustExist: true });
    try {
      assert.equal(verify.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      verify.close();
    }
    console.log("[Wave4] PASS T21d: Core worker SIGKILL recovers cleanly & PRAGMA integrity_check === ok");
  }
}

async function runT22ProcessTreeCleanup(exe: string, root: string): Promise<void> {
  const dir = join(root, "t22", ".mybuddy");
  const dbPath = join(dir, "app.db");
  mkdirSync(dir, { recursive: true });
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = join(root, "t22");
  process.env.USERPROFILE = join(root, "t22");

  let db: AppDatabase | undefined;
  let runtime: GadgetRuntime | undefined;
  let coreClient: CoreBusinessClient | undefined;

  try {
    await initializeCoreDatabase(exe, dir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
    db = await AppDatabase.open(dbPath, { runtimeAuditExecutable: exe, runtimeAuditSupervised: true, readonly: true });
    const reader = db.runtimeAuditReader!;
    const repository = new GadgetRepository(db.connection, reader);
    const storage = new GadgetStorage(join(dir, "gadgets"), reader);
    const registry = new GadgetRegistry();
    runtime = new GadgetRuntime(storage, registry, undefined, reader, { idleTimeoutMs: 60_000 });
    const service = new GadgetService({
      repository,
      storage,
      registry,
      runtime,
      workspaceExists: () => false,
      workspaceEffectiveArchived: () => false,
      taskExists: () => false,
      taskWorkspaceId: () => null,
      workspaceAncestors: () => [],
    });
    coreClient = await CoreBusinessClient.connect(exe, dbPath, { dataDirectory: dir, role: "background-service", clientId: "t22-svc" });

    // T22a: Node backend executing a grandchild tree holding TCP listening port + open file handle
    const treeDesc = await service.createAsync({
      name: "T22 Node Process Tree",
      scope: { type: "global" },
      backend: { entry: "server/index.mjs", commands: [process.execPath], timeoutMs: 30_000 },
      files: [
        { path: "index.html", content: "<html><body>t22</body></html>" },
        {
          path: "server/index.mjs",
          content: `
import { join } from "node:path";
export default async function(ctx) {
  return { actions: {
    startTree: async () => {
      const childCode = [
        'const net = require("node:net");',
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const dataPath = process.argv[1];',
        'const lockFd = fs.openSync(path.join(dataPath, "held.lock"), "w");',
        'fs.writeSync(lockFd, String(process.pid));',
        'const srv = net.createServer(() => {});',
        'srv.listen(0, "127.0.0.1", () => {',
        '  const port = srv.address().port;',
        '  const { spawn } = require("node:child_process");',
        '  const grand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
        '  fs.writeFileSync(path.join(dataPath, "grandchild.json"), JSON.stringify({ pid: process.pid, grandPid: grand.pid, port }));',
        '});',
        'setInterval(() => {}, 1000);',
      ].join("\\n");
      return await ctx.exec(${JSON.stringify(process.execPath)}, { args: ["-e", childCode, ctx.dataPath], timeoutMs: 25_000 });
    },
  } };
}`,
        },
      ],
    });

    const startedTreeState = await service.start(treeDesc.id);
    assert.equal(startedTreeState.status, "running");
    const hostPid = startedTreeState.pid!;
    assert(hostPid > 0 && alive(hostPid), "T22a: Node Gadget host process must be alive");

    const infoFile = join(storage.paths(treeDesc.id).dataPath, "grandchild.json");
    const heldLockFile = join(storage.paths(treeDesc.id).dataPath, "held.lock");
    const longCall = runtime.request(treeDesc, "actions/startTree", {}).catch(() => undefined);

    let childMeta!: { pid: number; grandPid: number; port: number };
    await until(() => {
      if (!existsSync(infoFile)) return false;
      try {
        childMeta = JSON.parse(readFileSync(infoFile, "utf8")) as { pid: number; grandPid: number; port: number };
        return childMeta.pid > 0 && childMeta.grandPid > 0 && childMeta.port > 0;
      } catch {
        return false;
      }
    }, "T22a managed child & grandchild spawn + bind TCP port", 10_000);

    assert(alive(childMeta.pid), "T22a: managed child process must be alive");
    assert(alive(childMeta.grandPid), "T22a: grandchild process must be alive");
    assert.equal(await canConnectTcp(childMeta.port), true, "T22a: child TCP listener must accept connections before stop");

    const stopStart = performance.now();
    await service.stop(treeDesc.id);
    await longCall;
    const stopElapsed = performance.now() - stopStart;
    assert(stopElapsed <= 5_000, `T22a stop must reap process tree within <=5000ms, got ${stopElapsed.toFixed(1)}ms`);

    await until(() => !alive(hostPid) && !alive(childMeta.pid) && !alive(childMeta.grandPid), "T22a host + child + grandchild PIDs terminated", 5_000);
    assert.equal(await canConnectTcp(childMeta.port), false, "T22a: TCP listener must be closed after cancel");
    assert.equal(await canBindPort(childMeta.port), true, "T22a: freed TCP port must be immediately re-bindable");
    unlinkSync(heldLockFile);
    assert.equal(existsSync(heldLockFile), false, "T22a: held file handle must be released so unlink succeeds on Windows");
    assert.equal(runtime.activeProcessCount(), 0);
    assert.equal(runtime.trackedPids().length, 0);
    console.log(`[Wave4] PASS T22a: Node tree (host=${hostPid}, child=${childMeta.pid}, grand=${childMeta.grandPid}, port=${childMeta.port}) reaped in ${stopElapsed.toFixed(1)}ms, port & FD released`);

    // T22b: Python process backend cancel -> process & TCP port released
    const pythonCmd = hasCommand("python", ["--version"]) ? "python" : hasCommand("python3", ["--version"]) ? "python3" : undefined;
    if (pythonCmd) {
      const pyDesc = await service.createAsync({
        name: "T22 Python Process",
        scope: { type: "global" },
        backend: { kind: "process", command: pythonCmd, args: ["-u", "worker.py"], cwd: "server", timeoutMs: 10_000 },
        files: [
          { path: "index.html", content: "<html><body>py</body></html>" },
          {
            path: "server/worker.py",
            content: `
import json, os, socket, sys, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
s.listen(1)
port = s.getsockname()[1]
print(json.dumps({"type": "ready", "version": 1, "actions": ["info"]}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("type") == "shutdown":
        s.close()
        sys.exit(0)
    if msg.get("type") == "call" and msg.get("action") == "info":
        print(json.dumps({"type": "result", "id": msg["id"], "value": {"pid": os.getpid(), "port": port}}), flush=True)
`,
          },
        ],
      });
      const pyInfo = await runtime.request(pyDesc, "actions/info", {}) as { pid: number; port: number };
      assert(pyInfo.pid > 0 && alive(pyInfo.pid));
      assert.equal(await canConnectTcp(pyInfo.port), true);
      const pyStopStart = performance.now();
      await service.stop(pyDesc.id);
      const pyStopMs = performance.now() - pyStopStart;
      assert(pyStopMs <= 5_000);
      await until(() => !alive(pyInfo.pid), "T22b python backend exited", 5_000);
      assert.equal(await canBindPort(pyInfo.port), true, "T22b: Python TCP port must be released");
      console.log(`[Wave4] PASS T22b: Python process (pid=${pyInfo.pid}, port=${pyInfo.port}) reaped in ${pyStopMs.toFixed(1)}ms`);
    } else {
      console.log("[Wave4] BLOCKED T22b: python runtime unavailable on PATH");
    }

    // T22c: Missing runtime explicit blocked state
    const missingDesc = await service.createAsync({
      name: "T22 Missing Runtime",
      scope: { type: "global" },
      backend: { kind: "process", command: "definitely-missing-runtime-t22-xyz", args: [], cwd: ".", timeoutMs: 1_000 },
      files: [{ path: "index.html", content: "<html><body>missing</body></html>" }],
    });
    const missingState = await runtime.start(missingDesc);
    assert.equal(missingState.status, "error");
    assert.equal(missingState.blocked, true);
    assert.equal(missingState.code, "RUNTIME_ENVIRONMENT_MISSING");
    assert.equal(runtime.activeProcessCount(), 0);
    console.log("[Wave4] PASS T22c: missing runtime explicitly reports blocked/RUNTIME_ENVIRONMENT_MISSING");
  } finally {
    await runtime?.disposeAll().catch(() => undefined);
    await coreClient?.close().catch(() => undefined);
    await db?.runtimeAuditReader?.close().catch(() => undefined);
    db?.close();
    await shutdownCoreWorker(dir, dbPath).catch(() => undefined);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  }
}

async function main(): Promise<void> {
  const exe = locateRuntimeAudit(process.cwd());
  if (!exe || !existsSync(exe)) throw new Error("Native runtime-audit binary missing");
  const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-wave4-"));
  try {
    await runT21DataCorrectness(exe, tempRoot);
    await runT22ProcessTreeCleanup(exe, tempRoot);
    console.log("ALL WAVE 4 T21..T22 ASSERTIONS PASSED");
  } finally {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore Windows handle release race */ }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
