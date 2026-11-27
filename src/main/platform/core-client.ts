import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants, createReadStream } from "node:fs";
import { access, chmod, copyFile, link, lstat, mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROTOCOL = 89;
const CONNECT_TIMEOUT_MS = 12_000;
const ATTEMPT_TIMEOUT_MS = 1_200;
const MAX_HANDSHAKE_BYTES = 8_192;
const RELEASE_VERSION = /^[0-9][a-zA-Z0-9.+-]{0,127}$/;

export type CoreClientRole = "ui" | "execution-host" | "background-service";

interface CoreEndpoint {
  pid: number;
  workerPid: number;
  port: number;
  token: string;
  generation: string;
  binaryHash: string;
  protocol: number;
  dbPath: string;
}

export interface ConnectCoreOptions {
  dataDirectory: string;
  signal?: AbortSignal;
  /** Allows a focused test to fail promptly; production uses the bounded default. */
  timeoutMs?: number;
  /** Role-scoped multiplexed connection identity (Step 3+). Omit for legacy exclusive client. */
  role?: CoreClientRole;
  clientId?: string;
}

export interface CoreDatabaseGuard {
  release(): Promise<void>;
}

/** Hold both OS ownership locks around synchronous schema initialization/replacement.
 * A live Core makes acquisition fail. Endpoint absence never authorizes deleting a DB. */
export async function acquireCoreDatabaseGuard(executable: string, dataDirectory: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CoreDatabaseGuard> {
  if (options.signal?.aborted) throw abortError();
  await mkdir(dataDirectory, { recursive: true });
  const directory = await realpath(dataDirectory);
  if (options.signal?.aborted) throw abortError();
  const child = spawn(executable, ["--guard-core-database", directory], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }), ...(process.env.TZ && { TZ: process.env.TZ }) },
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8_192); });
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>(resolveExit => child.once("exit", code => resolveExit(code)));
  await new Promise<void>((resolveReady, reject) => {
    let buffered = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      child.off("error", fail); child.off("exit", earlyExit); child.stdout.off("data", data);
      child.stdout.resume();
    };
    const fail = (error: Error) => {
      if (settled) return; settled = true; cleanup(); child.kill(); reject(error);
    };
    const earlyExit = () => fail(new Error(`Core database ownership guard unavailable: ${stderr.trim() || "process exited before readiness"}`));
    const abort = () => fail(abortError());
    const timer = setTimeout(() => fail(new Error("Core database ownership guard timed out")), options.timeoutMs ?? 4_000);
    const data = (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.length > MAX_HANDSHAKE_BYTES) { fail(new Error("Invalid Core database guard handshake")); return; }
      const newline = buffered.indexOf("\n"); if (newline < 0) return;
      try {
        const ready = JSON.parse(buffered.slice(0, newline)) as { coreDatabaseGuardReady?: boolean; pid?: number; protocol?: number };
        if (ready.coreDatabaseGuardReady !== true || ready.pid !== child.pid || ready.protocol !== PROTOCOL) throw new Error("Core database guard ownership handshake mismatch");
        settled = true; cleanup(); resolveReady();
      } catch (error) { fail(error as Error); }
    };
    child.on("error", fail); child.once("exit", earlyExit); child.stdout.on("data", data);
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  let releasing: Promise<void> | undefined;
  return { release: () => releasing ??= (async () => {
    child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error("Core database guard release timed out")); }, 3_000);
      })]);
      if (code !== 0) throw new Error(`Core database guard exited with ${code}: ${stderr.trim()}`);
    } finally { if (timer) clearTimeout(timer); }
  })() };
}

/** Delegate schema verification, incompatible-format reset, and initial schema
 * materialization to Rust under Core OS locks (`Step 4`, `RC-09`). */
export async function initializeCoreDatabase(
  executable: string,
  dataDirectory: string,
  dbPath: string,
  expectedVersion: number,
  releaseVersion?: string,
): Promise<{ schemaVersion: number; rebuilt: boolean; materialized: boolean }> {
  await mkdir(dataDirectory, { recursive: true });
  const directory = releaseVersion === undefined ? await realpath(dataDirectory) : resolve(dataDirectory);
  const { stdout } = await execFileAsync(executable, [
    "--init-database", directory, dbPath, String(expectedVersion),
    ...(releaseVersion === undefined ? [] : [releaseVersion]),
  ], {
    windowsHide: true,
    timeout: 15_000,
    env: { ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }), ...(process.env.TZ && { TZ: process.env.TZ }) },
  });
  return JSON.parse(stdout.trim()) as { schemaVersion: number; rebuilt: boolean; materialized: boolean };
}

/** The existing reader owns a connection, not the Core process. In particular kill()
 * closes this socket only; a completed UI lifecycle must not terminate background work. */
export class RuntimeCoreClient extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  readonly generation: string;
  readonly binaryHash: string;
  readonly role?: CoreClientRole;
  readonly clientId?: string;
  readonly connectionEpoch?: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private ended = false;

  private readonly socket: Socket;

  constructor(socket: Socket, endpoint: CoreEndpoint, initial: Buffer, identity?: { role?: CoreClientRole; clientId?: string; connectionEpoch?: number }) {
    super();
    this.socket = socket;
    this.pid = endpoint.workerPid;
    this.generation = endpoint.generation;
    this.binaryHash = endpoint.binaryHash;
    this.role = identity?.role;
    this.clientId = identity?.clientId;
    this.connectionEpoch = identity?.connectionEpoch;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (this.ended || socket.destroyed) { callback(new Error("Core connection is closed")); return; }
        socket.write(chunk, callback);
      },
      final: callback => { socket.end(); callback(); },
      destroy: (error, callback) => { socket.destroy(); callback(error); },
    });
    // The reader adds its own handler after connect resolves. Do not create an
    // unhandled stream error during the small handover window.
    this.stdin.on("error", () => {});
    socket.on("data", chunk => {
      if (!this.stdout.write(chunk)) socket.pause();
    });
    this.stdout.on("drain", () => { if (!this.ended) socket.resume(); });
    socket.on("error", error => {
      if (this.listenerCount("error")) this.emit("error", error);
    });
    socket.on("close", hadError => this.finish(hadError));
    // The worker's one-time startup notice was consumed before publishing core.json.
    // Every client receives a new ready notice, including reconnects to the same worker.
    this.stdout.write(Buffer.from('{"historyReady":true}\n'));
    if (initial.length) this.stdout.write(initial);
    socket.resume();
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.ended) return false;
    this.socket.destroy();
    return true;
  }

  private finish(failed: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = failed ? 1 : 0;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", this.exitCode, null);
    this.emit("close", this.exitCode, null);
  }
}

function abortError(): Error {
  const error = new Error("Core connection aborted");
  error.name = "AbortError";
  return error;
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolvePause, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolvePause(); };
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(abortError()); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function samePath(a: string, b: string): boolean {
  // Native canonical Windows paths may include the extended-length prefix.
  const normal = (path: string) => resolve(path.replace(/^\\\\\?\\/, ""));
  return process.platform === "win32" ? normal(a).toLowerCase() === normal(b).toLowerCase() : normal(a) === normal(b);
}

async function resolveCoreDatabasePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await lstat(path);
    return realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return join(await realpath(dirname(path)), basename(path));
}

async function readEndpoint(dataDirectory: string, ...databases: string[]): Promise<CoreEndpoint | undefined> {
  let value: Partial<CoreEndpoint>;
  try { value = JSON.parse(await readFile(join(dataDirectory, "core.json"), "utf8")) as Partial<CoreEndpoint>; }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!value || !Number.isInteger(value.protocol) || value.protocol! < 1 || !Number.isInteger(value.port) || value.port! < 1 || value.port! > 65535
    || !Number.isInteger(value.pid) || value.pid! <= 0 || !Number.isInteger(value.workerPid) || value.workerPid! <= 0
    || typeof value.token !== "string" || !/^[0-9a-f]{32}$/.test(value.token)
    || typeof value.generation !== "string" || typeof value.binaryHash !== "string" || !/^[0-9a-f]{64}$/.test(value.binaryHash)
    || typeof value.dbPath !== "string") {
    // A crashed publish or obsolete descriptor is not an ownership decision. A new
    // supervisor may replace it only after acquiring both OS guards; a live owner
    // still prevents takeover even when this metadata is malformed.
    return;
  }
  const dbPath = value.dbPath;
  if (!databases.some(database => samePath(dbPath, database))) throw new Error("Core data directory belongs to another database");
  return value as CoreEndpoint;
}

function connectEndpoint(endpoint: CoreEndpoint, signal?: AbortSignal, timeoutMs = ATTEMPT_TIMEOUT_MS, identity?: { role?: CoreClientRole; clientId?: string }): Promise<RuntimeCoreClient> {
  return new Promise((resolveClient, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const socket = connect({ host: "127.0.0.1", port: endpoint.port });
    let buffered = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.off("data", onData); socket.off("error", fail); socket.off("close", closed);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; cleanup(); socket.destroy(); reject(error);
    };
    const abort = () => fail(abortError());
    const closed = () => fail(new Error("Core closed before the ownership handshake"));
    const timer = setTimeout(() => fail(new Error("Core ownership handshake timed out")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(10);
      if (newline < 0) {
        if (buffered.length > MAX_HANDSHAKE_BYTES) fail(new Error("Core handshake exceeds limit"));
        return;
      }
      if (newline > MAX_HANDSHAKE_BYTES) { fail(new Error("Core handshake exceeds limit")); return; }
      let reply: { coreConnected?: boolean; coreRejected?: string; generation?: string; binaryHash?: string; workerPid?: number; protocol?: number; role?: CoreClientRole; clientId?: string; connectionEpoch?: number };
      try { reply = JSON.parse(buffered.subarray(0, newline).toString("utf8")); }
      catch { fail(new Error("Invalid Core handshake")); return; }
      if (reply.coreRejected) { fail(new Error(`Core connection rejected: ${reply.coreRejected}`)); return; }
      if (reply.coreConnected !== true || reply.generation !== endpoint.generation
        || reply.binaryHash !== endpoint.binaryHash || reply.workerPid !== endpoint.workerPid || reply.protocol !== endpoint.protocol
        || (identity?.role && reply.role !== identity.role)) {
        fail(new Error("Core ownership changed during connection")); return;
      }
      settled = true;
      socket.pause(); cleanup();
      resolveClient(new RuntimeCoreClient(socket, endpoint, buffered.subarray(newline + 1), {
        role: reply.role, clientId: reply.clientId, connectionEpoch: reply.connectionEpoch,
      }));
    };
    socket.on("data", onData); socket.on("error", fail); socket.on("close", closed);
    socket.once("connect", () => {
      socket.setNoDelay(true);
      const line = identity?.role
        ? `hello ${endpoint.token} ${JSON.stringify({ role: identity.role, ...(identity.clientId ? { clientId: identity.clientId } : {}) })}\n`
        : `hello ${endpoint.token}\n`;
      socket.write(line);
    });
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const binaryFingerprints = new Map<string, { stamp: string; hash: string }>();
async function fingerprint(file: string, published = false): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await stat(file, { bigint: true });
    const stamp = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
    const cached = binaryFingerprints.get(file);
    if (cached?.stamp === stamp) return cached.hash;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
    const after = await stat(file, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs) break;
    if (after.ctimeNs !== before.ctimeNs) {
      // Publishing a hard link and removing its temporary name changes the inode metadata.
      if (published) continue;
      break;
    }
    const hash = digest.digest("hex");
    if (binaryFingerprints.size >= 32) binaryFingerprints.delete(binaryFingerprints.keys().next().value!);
    binaryFingerprints.set(file, { stamp, hash });
    return hash;
  }
  throw new Error("Core executable changed while its fingerprint was being read");
}

function immutableBinaryPath(dataDirectory: string, hash: string): string {
  return join(dataDirectory, "core-binaries", hash, process.platform === "win32" ? "mybuddy-runtime-audit.exe" : "mybuddy-runtime-audit");
}

async function ensureWindowsMediumIntegrity(file: string): Promise<void> {
  if (process.platform !== "win32") return;
  const icacls = join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  try {
    await execFileAsync(icacls, [file, "/setintegritylevel", "M", "/L", "/Q"], { windowsHide: true, timeout: 15_000 });
  } catch { /* Low-IL callers cannot raise labels above their own token; medium-IL hosts succeed. */ }
}

/** Copy once to a content-addressed path. The installed/dev executable is never the
 * long-lived process image, so Windows and Linux can replace build outputs safely. */
export async function prepareCoreBinary(executable: string, dataDirectory: string): Promise<{ executable: string; hash: string }> {
  const source = await realpath(executable);
  const hash = await fingerprint(source);
  const destination = immutableBinaryPath(dataDirectory, hash);
  try {
    if (await fingerprint(destination, true) !== hash) throw new Error("Immutable Core executable fingerprint mismatch");
    return { executable: destination, hash };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(join(dataDirectory, "core-binaries", hash), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (await fingerprint(temporary) !== hash) throw new Error("Core executable changed during immutable copy");
    await chmod(temporary, Number((await stat(source)).mode & 0o777) || 0o755);
    await ensureWindowsMediumIntegrity(temporary);
    try {
      // Atomic no-replace publication: parallel clients never truncate or rename over
      // the executable another client has already started.
      await link(temporary, destination);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
  if (await fingerprint(destination, true) !== hash) throw new Error("Immutable Core executable fingerprint mismatch");
  return { executable: destination, hash };
}

async function stopEndpoint(endpoint: CoreEndpoint, dataDirectory: string, guardExecutable: string,
  deadline: number, signal?: AbortSignal): Promise<void> {
  const remaining = () => Math.max(1, deadline - Date.now());
  let client: RuntimeCoreClient | undefined;
  while (Date.now() < deadline) {
    try { client = await connectEndpoint(endpoint, signal, Math.min(ATTEMPT_TIMEOUT_MS, remaining())); break; }
    catch (error) {
      if (signal?.aborted) throw error;
      if (!(error instanceof Error) || !error.message.includes("busy")) throw error;
      await pause(Math.min(25, remaining()), signal);
    }
  }
  if (!client) throw new Error("The previous Core still has an active client; version switch did not terminate it");
  await new Promise<void>((resolveClose, reject) => {
    const timer = setTimeout(() => { client!.kill(); reject(new Error("Core shutdown timed out")); }, remaining());
    client!.once("close", () => { clearTimeout(timer); resolveClose(); });
    client!.stdin.write(JSON.stringify({ operation: "coreShutdown", requestId: `shutdown-${endpoint.generation}` }) + "\n");
  });
  await waitForCoreDatabaseOwnership(guardExecutable, dataDirectory, deadline, signal);
}

async function waitForCoreDatabaseOwnership(guardExecutable: string, dataDirectory: string, deadline: number, signal?: AbortSignal): Promise<void> {
  // Endpoint disappearance alone does not prove a worker is gone. Acquiring both OS
  // guards proves the retired parent and its worker released ownership before reuse.
  const remaining = () => Math.max(1, deadline - Date.now());
  let last: unknown;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    try {
      const guard = await acquireCoreDatabaseGuard(guardExecutable, dataDirectory, { signal, timeoutMs: remaining() });
      await guard.release(); return;
    } catch (error) { last = error; await pause(Math.min(20, remaining()), signal); }
  }
  throw new Error(`Core did not release process ownership: ${String(last)}`);
}

async function optionalRegularFile(path: string) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new Error(`升级数据库要求使用普通文件：${path}`);
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function isCurrentDatabaseRelease(directory: string, database: string, releaseVersion: string): Promise<boolean> {
  const stamp = join(directory, "database-release.json");
  const [databaseFile, stampFile] = await Promise.all([optionalRegularFile(database), optionalRegularFile(stamp)]);
  if (!stampFile) return false;
  if (stampFile.size > 4096) throw new Error("数据库版本记录过大，无法确认升级");
  const saved = JSON.parse(await readFile(stamp, "utf8")) as { releaseVersion?: unknown; databaseGeneration?: unknown; sqliteCutoverRecorded?: unknown } | null;
  if (typeof saved?.releaseVersion !== "string" || !RELEASE_VERSION.test(saved.releaseVersion) ||
      typeof saved.databaseGeneration !== "string" || !saved.databaseGeneration.trim() || Object.keys(saved).some(key => !["releaseVersion", "databaseGeneration", "sqliteCutoverRecorded"].includes(key)) ||
      (saved.sqliteCutoverRecorded !== undefined && typeof saved.sqliteCutoverRecorded !== "boolean")) {
    throw new Error("数据库版本记录无效，无法确认升级");
  }
  return Boolean(databaseFile?.size) && saved.sqliteCutoverRecorded === true && saved.releaseVersion === releaseVersion;
}

async function stopPriorCoreForUpgrade(endpoint: CoreEndpoint, executable: string, directory: string): Promise<void> {
  const transport = await connectEndpoint(endpoint, undefined, ATTEMPT_TIMEOUT_MS, { role: "ui", clientId: `package-upgrade-${process.pid}` }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") return undefined;
    throw error;
  });
  // A stale descriptor does not prove ownership is free. The initializer will
  // still have to acquire both guards before touching any database file.
  if (!transport) return;
  const { CoreBusinessClient } = await import("./core-business-client");
  const { RuntimeAuditUnknownOperationError } = await import("./runtime-audit");
  const prior = CoreBusinessClient.attachAuthenticated(transport);
  let stopUnconfirmed: Error | undefined;
  try {
    const original = immutableBinaryPath(directory, endpoint.binaryHash);
    if (await fingerprint(original) !== endpoint.binaryHash) throw new Error("升级前 Core 可执行文件身份校验失败");
    const status = await prior.piHost<{ hosts?: Array<{ pid: number; status: string; dbPath: string }> }>({ action: "status" });
    if (!Array.isArray(status.hosts)) throw new Error("Core 未确认旧 Pi 宿主列表");
    const hosts = status.hosts.filter(host => ["launching", "starting", "bootstrapping", "running"].includes(host.status));
    if (hosts.some(host => !Number.isSafeInteger(host.pid) || host.pid < 0 || host.pid === process.pid ||
        typeof host.dbPath !== "string" || !samePath(host.dbPath, endpoint.dbPath))) throw new Error("升级前 Pi 宿主归属未确认");
    const stopped = await prior.piHost<{ stopped?: number }>({ action: "stop", reason: "package_upgrade" });
    if (typeof stopped.stopped !== "number" || !Number.isSafeInteger(stopped.stopped) || stopped.stopped < 0) {
      throw new Error("Core 未确认旧 Pi 宿主已停止");
    }
    const stillRunning = ({ pid }: { pid: number }) => {
      if (!pid) return false;
      try { process.kill(pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (hosts.some(stillRunning)) {
      if (Date.now() >= deadline) throw new Error("旧 Pi 宿主在升级前未退出");
      await pause(40);
    }
    try {
      const reply = await prior.assistantLifecycle("stop", { reason: "package_upgrade" });
      if (reply.status !== "ok" || reply.state.mode !== "stopped_explicitly") throw new Error("Core 未确认升级停机");
    } catch (error) {
      if (!(error instanceof RuntimeAuditUnknownOperationError)) throw error;
      stopUnconfirmed = error;
    }
  } finally {
    await prior.close();
  }
  await waitForCoreDatabaseOwnership(executable, directory, Date.now() + CONNECT_TIMEOUT_MS);
  if (stopUnconfirmed) {
    const { readCoreLifecycleFile } = await import("./core-autostart");
    const lifecycle = await readCoreLifecycleFile(directory);
    if (lifecycle.mode !== "stopped_explicitly" || lifecycle.reason !== "package_upgrade") throw stopUnconfirmed;
  }
}

/** The guarded Rust initializer clears legacy SQLite once and preserves DuckDB
 * when the packaged release changes. It alone writes the release stamp. */
export async function preparePackagedCoreDatabase(executable: string, dataDirectory: string, expectedVersion: number,
  releaseVersion: string): Promise<void> {
  if (!RELEASE_VERSION.test(releaseVersion)) throw new Error("MyBuddy 应用版本无效，无法确认升级");
  if (!(await stat(executable)).isFile()) throw new Error("Rust 核心程序缺失，无法检查发行版本数据库");
  await access(executable, constants.X_OK);
  const requestedDirectory = resolve(dataDirectory);
  if (basename(requestedDirectory) !== ".mybuddy") throw new Error("升级数据库要求使用 MyBuddy 数据目录");
  await mkdir(requestedDirectory, { recursive: true });
  let ancestor = requestedDirectory;
  for (;;) {
    if (!(await lstat(ancestor)).isDirectory()) throw new Error("升级数据库要求使用普通 MyBuddy 数据目录");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const directory = await realpath(requestedDirectory);
  const database = join(directory, "app.duckdb");
  if (await isCurrentDatabaseRelease(directory, database, releaseVersion)) return;
  const legacy = join(directory, "app.db");
  const previous = await readEndpoint(directory, database, legacy);
  if (previous) {
    if (await isCurrentDatabaseRelease(directory, database, releaseVersion)) return;
    await optionalRegularFile(previous.dbPath);
    await stopPriorCoreForUpgrade(previous, executable, directory);
  }
  await initializeCoreDatabase(executable, requestedDirectory, join(requestedDirectory, "app.duckdb"), expectedVersion, releaseVersion);
}

/** Starts only a detached supervisor. Its OS guards arbitrate concurrent launches; the
 * client never removes a lease or guesses owner death from an unreachable TCP port. */
export async function connectCoreWorker(executable: string, dbPath: string, options: ConnectCoreOptions): Promise<RuntimeCoreClient> {
  await mkdir(options.dataDirectory, { recursive: true });
  const [database, directory] = await Promise.all([resolveCoreDatabasePath(dbPath), realpath(options.dataDirectory)]);
  const binary = await prepareCoreBinary(executable, directory);
  const deadline = Date.now() + (options.timeoutMs ?? CONNECT_TIMEOUT_MS);
  let nextLaunch = 0;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw abortError();
    const endpoint = await readEndpoint(directory, database);
    if (endpoint) {
      try {
        if (endpoint.binaryHash === binary.hash && endpoint.protocol !== PROTOCOL) {
          throw new Error(`Core executable protocol ${endpoint.protocol} does not match host protocol ${PROTOCOL}`);
        }
        if (endpoint.binaryHash !== binary.hash) {
          await stopEndpoint(endpoint, directory, binary.executable, deadline, options.signal);
          nextLaunch = 0;
        } else {
          return await connectEndpoint(
            endpoint,
            options.signal,
            Math.min(ATTEMPT_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
            options.role ? { role: options.role, clientId: options.clientId } : undefined,
          );
        }
      }
      catch (error) { lastError = error as Error; if (options.signal?.aborted) throw error; }
    }
    // A failed lease acquisition exits promptly. Rate limiting prevents startup storms
    // while a previous worker is safely draining after its parent's death.
    if (Date.now() >= nextLaunch) {
      const child = spawn(binary.executable, ["--supervise", directory, database], {
        detached: true, stdio: "ignore", windowsHide: true,
        env: {
          ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
          ...(process.env.TZ && { TZ: process.env.TZ }),
          ...(process.env.MYBUDDY_WORK_AUTO_TICK_MS && { MYBUDDY_WORK_AUTO_TICK_MS: process.env.MYBUDDY_WORK_AUTO_TICK_MS }),
          ...(process.env.MYBUDDY_PI_HOST_STARTUP_GRACE_MS && { MYBUDDY_PI_HOST_STARTUP_GRACE_MS: process.env.MYBUDDY_PI_HOST_STARTUP_GRACE_MS }),
          ...(process.env.MYBUDDY_PI_HOST_HEARTBEAT_TIMEOUT_MS && { MYBUDDY_PI_HOST_HEARTBEAT_TIMEOUT_MS: process.env.MYBUDDY_PI_HOST_HEARTBEAT_TIMEOUT_MS }),
          ...(process.env.MYBUDDY_READ_POOL_WORKERS && { MYBUDDY_READ_POOL_WORKERS: process.env.MYBUDDY_READ_POOL_WORKERS }),
          ...(process.env.MYBUDDY_WORKSPACE_IO_WORKERS && { MYBUDDY_WORKSPACE_IO_WORKERS: process.env.MYBUDDY_WORKSPACE_IO_WORKERS }),
          ...(process.env.MYBUDDY_ORT_INTRA_THREADS && { MYBUDDY_ORT_INTRA_THREADS: process.env.MYBUDDY_ORT_INTRA_THREADS }),
          ...(process.env.MYBUDDY_ORT_INTER_THREADS && { MYBUDDY_ORT_INTER_THREADS: process.env.MYBUDDY_ORT_INTER_THREADS }),
          ...(process.env.MYBUDDY_TEST_GADGET_FSYNC_DELAY_MATCH && { MYBUDDY_TEST_GADGET_FSYNC_DELAY_MATCH: process.env.MYBUDDY_TEST_GADGET_FSYNC_DELAY_MATCH }),
          ...(process.env.MYBUDDY_TEST_GADGET_SPAWN_FAIL_ONCE && { MYBUDDY_TEST_GADGET_SPAWN_FAIL_ONCE: process.env.MYBUDDY_TEST_GADGET_SPAWN_FAIL_ONCE }),
        },
      });
      child.on("error", error => { lastError = error; });
      child.unref();
      nextLaunch = Date.now() + 750;
    }
    await pause(Math.min(40, Math.max(1, deadline - Date.now())), options.signal);
  }
  throw new Error(`Core did not become available: ${lastError?.message ?? "startup deadline exceeded"}`);
}

/** Explicit lifecycle endpoint for isolated acceptance fixtures and application teardown
 * commands. Ordinary RuntimeAuditReader.close() must only disconnect its own client. */
export async function shutdownCoreWorker(dataDirectory: string, dbPath: string, timeoutMs = 4_000): Promise<void> {
  const database = await resolveCoreDatabasePath(dbPath);
  const endpoint = await readEndpoint(dataDirectory, database);
  if (!endpoint) return;
  const executable = immutableBinaryPath(dataDirectory, endpoint.binaryHash);
  if (await fingerprint(executable) !== endpoint.binaryHash) throw new Error("Core shutdown executable fingerprint mismatch");
  await stopEndpoint(endpoint, dataDirectory, executable, Date.now() + timeoutMs);
}
