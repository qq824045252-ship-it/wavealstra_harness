#!/usr/bin/env node
/**
 * core-supervisor-test.mjs — 3.6 的第一份契约证据。
 *
 * 用真实发行包 worker 验证 Core 监督进程：租约互斥、客户端断开后 worker 仍活着、
 * 硬杀后下一次启动接管。缺二进制直接失败（不允许用回退路径冒充通过）。
 *
 * 用法：pnpm -s test:core-supervisor
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const platform = { win32: "win-x64", linux: "linux-x64" }[process.platform];
const binary = join(ROOT, "out", "native", platform,
  process.platform === "win32" ? "mybuddy-runtime-audit.exe" : "mybuddy-runtime-audit");
assert(existsSync(binary), `缺少原生 worker：${binary}（先运行 node scripts/prepare-runtime-audit.cjs）`);

const sandbox = mkdtempSync(join(ROOT, "out", "tests", "core-supervisor-"));
const dataDir = join(sandbox, "data");
mkdirSync(dataDir);
const dbPath = join(sandbox, "app.db");
writeFileSync(dbPath, "");
const endpointFile = join(dataDir, "core.json");
const leaseFile = join(dataDir, "core.lease");
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function startCore() {
  const child = spawn(binary, ["--supervise", dataDir, dbPath], { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.exited = new Promise(resolve => child.on("exit", code => resolve(code)));
  child.errorText = () => stderr;
  return child;
}

async function endpoint({ notPid, timeoutMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(endpointFile)) {
      try {
        const parsed = JSON.parse(readFileSync(endpointFile, "utf8"));
        if (parsed.pid !== notPid) return parsed;
      } catch { /* partially written, retry */ }
    }
    await sleep(40);
  }
  throw new Error("core did not publish an endpoint");
}

function request(target, operation, requestId) {
  return new Promise((resolve, reject) => {
    const socket = connect(target.port, "127.0.0.1");
    let buffered = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${operation}: timeout`)); }, 4_000);
    socket.on("connect", () => {
      socket.write(`hello ${target.token}\n`);
      socket.write(JSON.stringify({ operation, requestId }) + "\n");
    });
    socket.on("data", chunk => {
      buffered += chunk;
      const index = buffered.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      const reply = JSON.parse(buffered.slice(0, index));
      socket.destroy();
      resolve(reply);
    });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { clearTimeout(timer); reject(new Error(`${operation}: closed without a reply`)); });
  });
}

const children = [];
try {
  const first = startCore();
  children.push(first);
  const a = await endpoint();
  assert(/^[0-9a-f]{32}$/.test(a.token), "the endpoint carries a 32-hex token");
  assert.equal(JSON.parse(readFileSync(leaseFile, "utf8")).pid, a.pid, "the lease names the running core");
  assert.equal((await request(a, "nativeInferenceSupported", "a1")).data, true);

  // The whole point: the worker outlives the client that asked for the work.
  assert.equal((await request(a, "nativeInferenceSupported", "a2")).data, true,
    "a second client is served by the same worker");

  const second = startCore();
  children.push(second);
  assert.equal(await second.exited, 1, "a second core must refuse to share the data directory");
  assert.match(second.errorText(), /core already running/);
  assert.equal(JSON.parse(readFileSync(leaseFile, "utf8")).pid, a.pid, "the refused core leaves the lease alone");

  // A hard kill leaves the files behind on purpose; the next core takes over by probing.
  first.kill();
  await first.exited;
  await sleep(300);
  assert(existsSync(endpointFile) && existsSync(leaseFile), "a killed core leaves its files for takeover");

  const third = startCore();
  children.push(third);
  const c = await endpoint({ notPid: a.pid });
  assert.notEqual(c.pid, a.pid, "the replacement core owns the directory");
  assert.equal((await request(c, "nativeInferenceSupported", "c1")).data, true);
  third.kill();
  await third.exited;

  console.log("PASS core supervisor: lease exclusion, client-independent worker, takeover after a hard kill");
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  rmSync(sandbox, { recursive: true, force: true });
}
