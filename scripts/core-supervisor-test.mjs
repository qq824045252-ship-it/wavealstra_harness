#!/usr/bin/env node
/** Real Core ownership and connection failure contracts. Every wait has a local
 * deadline; cleanup terminates only the fixture's recorded supervisor/worker PIDs. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const platform = { win32: "win-x64", linux: "linux-x64" }[process.platform];
const binary = process.env.RUNTIME_AUDIT_BINARY ?? join(ROOT, "out", "native", platform,
  process.platform === "win32" ? "mybuddy-runtime-audit.exe" : "mybuddy-runtime-audit");
assert(existsSync(binary), `缺少原生 worker：${binary}`);
mkdirSync(join(ROOT, "out", "tests"), { recursive: true });
const sandbox = mkdtempSync(join(ROOT, "out", "tests", "core-supervisor-"));
const dataDir = join(sandbox, "data"); mkdirSync(dataDir);
const dbPath = join(sandbox, "app.duckdb");
const historyStore = "fixture-history";
const historyText = "Durable history survives reconnect";
const endpointFile = join(dataDir, "core.json");
const leaseFile = join(dataDir, "core.lease");
const children = [];
const workers = new Set();
const sockets = new Set();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function within(promise, message, timeoutMs = 3_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}

function startCore(dir = dataDir, db = dbPath) {
  const child = spawn(binary, ["--supervise", dir, db], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
  child.exited = new Promise((resolveExit, reject) => {
    child.once("exit", code => resolveExit(code)); child.once("error", reject);
  });
  child.errorText = () => stderr;
  children.push(child); return child;
}

async function endpoint({ notGeneration, timeoutMs = 6_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(readFileSync(endpointFile, "utf8"));
      if (parsed.generation !== notGeneration) { workers.add(parsed.workerPid); return parsed; }
    } catch { /* unpublished */ }
    await sleep(20);
  }
  throw new Error(`core did not publish: ${children.map(child => child.errorText()).join("\n")}`);
}

async function channel(target) {
  const socket = connect(target.port, "127.0.0.1"); sockets.add(socket);
  const pending = new Map();
  let buffered = Buffer.alloc(0);
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  socket.on("connect", () => socket.write(`hello ${target.token}\n`));
  socket.on("data", chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const newline = buffered.indexOf(10); if (newline < 0) break;
      let reply;
      try { reply = JSON.parse(buffered.subarray(0, newline).toString("utf8")); }
      catch (error) { rejectReady(error); for (const entry of pending.values()) entry.reject(error); socket.destroy(); return; }
      buffered = buffered.subarray(newline + 1);
      if (reply.coreConnected) resolveReady(reply);
      else if (reply.coreRejected) { rejectReady(new Error(reply.coreRejected)); socket.destroy(); }
      else if (pending.has(reply.replyId)) {
        const entry = pending.get(reply.replyId); pending.delete(reply.replyId); entry.resolve(reply);
      }
    }
  });
  const failed = error => { rejectReady(error); for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  socket.on("error", failed);
  socket.on("close", () => { sockets.delete(socket); failed(new Error("client closed")); });
  try { await within(ready, "client handshake timeout", 2_000); } catch (error) { socket.destroy(); throw error; }
  const send = payload => {
    const requestId = payload.requestId ?? randomUUID();
    socket.write(JSON.stringify({ deadlineAt: Date.now() + 10_000, ...payload, requestId }) + "\n");
    return requestId;
  };
  return {
    socket,
    send,
    ask(payload, timeoutMs = 3_000) {
      const requestId = payload.requestId ?? randomUUID();
      const reply = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
      send({ ...payload, requestId });
      return within(reply, `${payload.operation} reply timeout`, timeoutMs).finally(() => pending.delete(requestId));
    },
    async close() {
      if (socket.destroyed) return;
      const closed = new Promise(resolve => socket.once("close", resolve)); socket.destroy();
      await within(closed, "client close timeout");
    },
  };
}

async function connectEventually(target, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs; let last;
  while (Date.now() < deadline) {
    try { return await channel(target); } catch (error) { last = error; await sleep(25); }
  }
  throw last ?? new Error("client never became available");
}

async function ping(client) {
  const reply = await client.ask({ operation: "nativeInferenceSupported" });
  assert.equal(reply.status, "ok", JSON.stringify(reply)); assert.equal(reply.data, true);
}

async function openHistory(client, session) {
  const reply = await client.ask({ operation: "historyRead", action: "open", session, storeId: historyStore });
  assert.equal(reply.status, "ok", JSON.stringify(reply)); assert.equal(reply.data, true);
}

async function seedHistory(client) {
  const opened = await client.ask({ operation: "piStorage", payload: { action: "openWriter", storeId: historyStore } });
  assert.equal(opened.data?.ok, true);
  const saved = await client.ask({ operation: "piStorage", payload: {
    action: "commit", storeId: historyStore, writerEpoch: opened.data.data.writerEpoch,
    batches: [[
      { type: "conversation", value: { id: 1 } },
      { type: "entry", value: { id: 2, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: historyText }] } },
    ]],
  } });
  assert.equal(saved.data?.data?.stored, 1);
}

try {
  assert(!existsSync(dbPath));
  // A lease must be exclusive even before endpoint publication, including path aliases.
  const aliasDataDir = join(sandbox, "data-alias");
  symlinkSync(dataDir, aliasDataDir, process.platform === "win32" ? "junction" : "dir");
  const aliasDbPath = process.platform === "win32" ? join(sandbox, "APP.DUCKDB") : dbPath;
  const contenders = [startCore(dataDir, dbPath), startCore(aliasDataDir, aliasDbPath), startCore(dataDir, dbPath)];
  const a = await endpoint();
  const first = contenders.find(child => child.pid === a.pid); assert(first);
  for (const child of contenders.filter(child => child !== first)) {
    assert.equal(await within(child.exited, "concurrent loser did not exit"), 1);
    assert.match(child.errorText(), /core already running/);
  }
  assert.equal(JSON.parse(readFileSync(leaseFile, "utf8")).nonce, a.generation);
  assert.notEqual(a.workerPid, a.pid);
  assert(existsSync(dbPath));
  console.log("PASS concurrent cold startup creates DuckDB with one OS-held owner and one ready worker");

  const half = connect(a.port, "127.0.0.1"); sockets.add(half);
  half.on("error", () => {}); half.on("close", () => sockets.delete(half));
  const halfClosed = new Promise(resolve => half.once("close", resolve));
  await within(new Promise(resolve => half.once("connect", resolve)), "half connection timeout");
  half.write("hello ");
  let client = await channel(a); await ping(client);
  await within(halfClosed, "half handshake was not retired", 2_000);
  console.log("PASS an incomplete handshake cannot block a healthy client or the supervisor");

  // A dead TCP endpoint does not invalidate a live owner's OS lock.
  const savedEndpoint = readFileSync(endpointFile);
  rmSync(endpointFile);
  const refused = startCore();
  assert.equal(await within(refused.exited, "unpublished owner was not protected"), 1);
  assert.match(refused.errorText(), /core already running/);
  writeFileSync(endpointFile, savedEndpoint);
  await ping(client);
  console.log("PASS endpoint absence never steals a live lease");

  await seedHistory(client);
  await openHistory(client, "reused-session");
  await client.close();
  client = await connectEventually(a);
  await openHistory(client, "reused-session");
  const head = await client.ask({ operation: "historyRead", action: "head", session: "reused-session", conversationId: 1, maxTokens: 100 });
  assert.equal(head.data, `用户：${historyText}`);
  console.log("PASS disconnect releases the old client's Durable snapshot before reconnect");

  const gadgetPath = join(sandbox, "gadget"); mkdirSync(gadgetPath);
  const openedGadget = await client.ask({ operation: "gadgetState", request: { kind: "open", path: gadgetPath } });
  assert.equal(openedGadget.data.kind, "opened");
  const gadgetGeneration = randomUUID();
  const writeGadget = (generation, value) => ({ operation: "gadgetState", request: {
    kind: "access", path: gadgetPath, canonicalPath: openedGadget.data.canonicalPath, bucket: "storage",
    action: { operation: "set", key: [107], valueJson: JSON.stringify(value), writeId: randomUUID() },
    authorization: { generation, invocationId: "background", expiresAt: 0 },
  } });
  assert.equal((await client.ask(writeGadget(gadgetGeneration, 1))).data.kind, "value");
  await client.close(); client = await connectEventually(a);
  assert.deepEqual((await client.ask(writeGadget(gadgetGeneration, 2))).data, { kind: "error", error: "STALE_WRITE" });
  assert.equal(JSON.parse(readFileSync(join(gadgetPath, ".mybuddy-state.json"), "utf8")).storage.k.value, 1);
  assert.equal((await client.ask(writeGadget(randomUUID(), 3))).data.kind, "value");
  await openHistory(client, "reused-session");
  console.log("PASS disconnect revokes background Gadget generations at the worker commit gate");

  // Fill the socket's send buffer / queue cap with complete, valid responses (Windows
  // loopback autotuning can absorb >20MB in a single write). The worker must remain
  // drainable after this client stops consuming bytes.
  client.socket.pause();
  for (let i = 0; i < 4; i++) {
    client.send({ operation: "historyRead", action: "select", session: "reused-session", sql: "SELECT repeat('x', 20000000) AS payload", parameters: [], first: true });
  }
  const recovered = await connectEventually(a, 6_000);
  await ping(recovered);
  await openHistory(recovered, "reused-session");
  await client.close(); client = recovered;
  assert.equal(JSON.parse(readFileSync(endpointFile, "utf8")).workerPid, a.workerPid);
  console.log("PASS slow output consumer is disconnected without blocking the worker or corrupting the next client's frames");

  process.kill(a.workerPid, "SIGKILL");
  assert.equal(await within(first.exited, "supervisor did not notice worker death"), 1);
  await client.close();
  const replacement = startCore();
  const b = await endpoint({ notGeneration: a.generation });
  client = await channel(b); await ping(client);
  console.log("PASS worker death retires the endpoint and a new generation reconnects");

  await openHistory(client, "inflight");
  const slowId = client.send({ operation: "historyRead", action: "select", session: "inflight", sql: "SELECT (WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n) AS value", parameters: [], first: true });
  const runningDeadline = Date.now() + 2_000;
  let running = false;
  while (Date.now() < runningDeadline) {
    const status = await client.ask({ operation: "control", action: "status", targetRequestId: slowId });
    if (status.data.state === "running") { running = true; break; }
    await sleep(10);
  }
  assert(running, "the expensive read must really be in flight before killing its supervisor");
  replacement.kill("SIGKILL"); await within(replacement.exited, "supervisor kill timeout");
  const overlap = startCore();
  assert.equal(await within(overlap.exited, "replacement did not refuse the live old worker"), 1);
  assert.match(overlap.errorText(), /previous core worker still running/);
  // This fixture deliberately terminates its busy worker after proving the fence.
  process.kill(b.workerPid, "SIGKILL"); await client.close(); await sleep(100);
  const finalCore = startCore();
  const c = await endpoint({ notGeneration: b.generation });
  client = await channel(c); await ping(client);
  console.log("PASS supervisor crash cannot admit a replacement while its old worker is still executing");

  client.send({ operation: "coreShutdown" });
  assert.equal(await within(finalCore.exited, "explicit Core shutdown timeout"), 0);
  await client.close();
  assert(!existsSync(endpointFile));
  assert.equal(readFileSync(dbPath).subarray(8, 12).toString("ascii"), "DUCK");
  assert(existsSync(join(dataDir, "core.lock")), "lock inodes stay stable across lifetimes");
  console.log("PASS explicit shutdown reaps the worker and removes discovery metadata");
} finally {
  for (const socket of sockets) socket.destroy();
  for (const pid of workers) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  await Promise.allSettled(children.map(child => within(child.exited, "fixture process cleanup timeout", 2_000)));
  await sleep(100);
  rmSync(sandbox, { recursive: true, force: true });
}
