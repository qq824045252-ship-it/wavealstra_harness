import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import type { GadgetClient } from "../src/shared/gadget-backend";
import { GADGET_MANIFEST_SCHEMA_VERSION, type GadgetDescriptor } from "../src/shared/gadget-types";
import { currentNodePlatform } from "../src/main/platform/runtime";
import { terminateGadgetCommands } from "../src/main/platform/gadget-commands";

const root = mkdtempSync(join(tmpdir(), "mybuddy-gadget-backend-"));
const storage = new GadgetStorage(join(root, "gadgets"));
const registry = new GadgetRegistry();
const runtime = new GadgetRuntime(storage, registry);
const deadline = setTimeout(() => { console.error("gadget backend test exceeded 90 seconds"); process.exit(1); }, 90_000);
const source = (version: string) => `export default async function(ctx) { return { actions: {
  version: async () => ${JSON.stringify(version)},
  command: async input => { const r = await ctx.exec('node', {args:['-e', 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.stringify({arg:process.argv[1],stdin:JSON.parse(s)})))', input.arg], stdin: JSON.stringify(input.data)}); return JSON.parse(r.stdout); },
  wait: async input => { await new Promise(resolve => setTimeout(resolve,input.ms)); return input.value; },
  blocked: async () => { await ctx.storage.set('started', true); await new Promise(resolve => setTimeout(resolve,400)); return 'done'; },
  lateWrite: async () => { await ctx.storage.set('late-started', true); await new Promise(resolve => setTimeout(resolve,600)); try { await ctx.storage.set('late','bad'); } finally { (await import('node:fs')).writeFileSync(ctx.dataPath+'/late-finished','done'); } return 'unexpected'; },
  never: async () => await new Promise(() => {}),
  spawn: async () => ctx.exec('node', {args:['-e','require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',ctx.dataPath+'/child.pid'], timeoutMs:10000})
} }; }`;

function fixture(id: string): GadgetDescriptor {
  const manifest = { schemaVersion: GADGET_MANIFEST_SCHEMA_VERSION, name: id, type: "web" as const, entry: "index.html", defaultConfig: { theme: "light" }, backend: { entry: "server/index.mjs", commands: ["node"], environment: [], timeoutMs: 500 } };
  const paths = storage.create(id, manifest, [
    { path: "index.html", content: "<!doctype html><html><head></head><body>fixture</body></html>" },
    { path: "server/index.mjs", content: source("one") },
    { path: ".env", content: "SECRET=not-public" },
    { path: "secret.txt", content: "not-public" },
  ]);
  return { id, name: id, scope: { type: "global" }, type: "web", manifestPath: paths.manifestPath, sourcePath: paths.sourcePath, metadata: {}, createdAt: Date.now(), updatedAt: Date.now() };
}

async function client(url: string): Promise<GadgetClient> {
  const sdk = await (await fetch(new URL("__mybuddy/sdk.js", url))).text();
  const window: { gadget?: GadgetClient } = {};
  runInNewContext(sdk, { window, document: { addEventListener() {} }, location: { origin: new URL(url).origin }, fetch, Element: class {} });
  assert(window.gadget);
  return window.gadget;
}

function raw(url: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { path, method: "POST", headers }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end('{}');
  });
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function checkProcessBackend(): Promise<void> {
  const item = fixture("external-process");
  const source = storage.readSource(item.id);
  storage.updateSource({
    gadgetId: item.id,
    expectedRevision: source.revision,
    backend: { kind: "process", command: "node", cwd: "server", args: ["worker.cjs", "argument with spaces"],
      environment: ["MYBUDDY_TEST_GADGET_MARKER"], timeoutMs: 900 },
    files: [{ path: "server/worker.cjs", content: readFileSync("scripts/fixtures/gadget-process-backend.cjs", "utf8") }],
  }, () => {});
  process.env.MYBUDDY_TEST_GADGET_MARKER = "declared";
  process.env.MYBUDDY_TEST_GADGET_UNDECLARED = "private";
  let descendant: number | undefined;
  try {
    const running = await runtime.start(item);
    assert.equal(running.status, "running", running.error);
    const sdk = await client(running.url!);
    const first = await sdk.call("echo", "你好") as { pid: number };
    assert(Number.isSafeInteger(first.pid) && first.pid !== running.pid);
    assert.deepEqual(first, { input: "你好", count: 1, pid: first.pid, arg: "argument with spaces", marker: "declared", privateMarker: null });
    assert.deepEqual(await sdk.call("echo", 7), { ...first, input: 7, count: 2 });
    assert.deepEqual(await sdk.call("store", 34), { value: 34, theme: "light" });
    assert.equal(await sdk.storage.get("external"), 34);
    assert.equal((await fetch(new URL("server/worker.cjs", running.url!))).status, 404);

    const abort = new AbortController();
    const cancelled = assert.rejects(sdk.call("cancellable", null, { signal: abort.signal }));
    await until(async () => await sdk.storage.get("external-started") === true, "external call is active");
    abort.abort();
    await cancelled;
    await until(async () => await sdk.call("cancelStatus") === "CANCELLED", "cancel reaches worker and revokes its storage writes");
    assert.equal(await sdk.storage.get("late"), null);

    descendant = await sdk.call("descendant") as number;
    assert(Number.isSafeInteger(descendant) && alive(descendant));
    const restarted = await runtime.restart(item);
    assert.equal(restarted.status, "running", restarted.error);
    assert.equal(alive(first.pid), false);
    await until(() => !alive(descendant!), "restart reaps the external backend's descendant");
    descendant = undefined;
    const fresh = await client(restarted.url!);
    assert.equal(await fresh.storage.get("external"), 34);
    const second = await fresh.call("echo") as { pid: number; count: number };
    assert.equal(second.count, 1);
    await assert.rejects(fresh.call("hang"), /超时/);
    await until(() => registry.runtime(item.id).status === "error" && !alive(second.pid), "hung worker and host stopped");

    const afterTimeout = await runtime.start(item);
    assert.equal(afterTimeout.status, "running", afterTimeout.error);
    const afterTimeoutClient = await client(afterTimeout.url!);
    await assert.rejects(afterTimeoutClient.call("crash"));
    await until(() => registry.runtime(item.id).error?.includes("code=17") === true, "reports worker's exit code");

    const failedSource = storage.readSource(item.id);
    storage.updateSource({ gadgetId: item.id, expectedRevision: failedSource.revision,
      backend: { kind: "process", command: "missing-gadget-test-executable" },
      files: [{ path: "index.html", content: "<html>missing program test</html>" }],
    }, () => {});
    const failed = await runtime.start(item);
    assert.equal(failed.status, "error");
    assert.match(failed.error ?? "", /missing-gadget-test-executable/);

    const oversizedSource = storage.readSource(item.id);
    storage.updateSource({ gadgetId: item.id, expectedRevision: oversizedSource.revision,
      backend: { kind: "process", command: "node", args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);"] },
      files: [{ path: "index.html", content: "<html>oversized process frame test</html>" }],
    }, () => {});
    const oversized = await runtime.start(item);
    assert.equal(oversized.status, "error");
    assert.match(oversized.error ?? "", /无效的协议消息/);
  } finally {
    if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
    delete process.env.MYBUDDY_TEST_GADGET_MARKER;
    delete process.env.MYBUDDY_TEST_GADGET_UNDECLARED;
    await runtime.stop(item.id);
  }
}

async function main(): Promise<void> {
  const a = fixture("a");
  const b = fixture("b");
  const started = await runtime.start(a);
  assert.equal(started.status, "running", started.error);
  const sdk = await client(started.url!);
  assert.equal(await sdk.call("version"), "one");
  assert.equal(await sdk.config.get("theme"), "light");
  await sdk.config.set("theme", "dark");
  assert.equal(await sdk.config.get("theme"), "dark");
  const first = await sdk.storage.set("counter", { count: 1 }, null);
  assert(first.revision);
  await assert.rejects(sdk.storage.set("counter", 2, null), /修改|revision/i);
  await sdk.storage.set("counter", { count: 2 }, first.revision);
  assert.deepEqual(await sdk.storage.get("counter"), { count: 2 });
  assert.deepEqual(await sdk.call("command", { arg: "hello world", data: { n: 7 } }), { arg: "hello world", stdin: { n: 7 } });
  await assert.rejects(sdk.call("missing"));
  for (const path of ["server/index.mjs", ".env", "secret.txt", "%2e%2e%2f.env"]) {
    assert.notEqual((await fetch(new URL(path, started.url!))).status, 200, path);
  }
  assert.equal(await raw(started.url!, "/__mybuddy/storage", { host: "evil.test", "content-type": "application/json" }), 403);
  assert.equal(await raw(started.url!, "/__mybuddy/storage", { origin: "https://evil.test", "content-type": "application/json" }), 403);
  assert.equal(await raw(started.url!, "/__mybuddy/storage", { "sec-fetch-site": "same-site", "content-type": "application/json" }), 403);
  assert.equal((await fetch(new URL("__mybuddy/sdk.js", started.url!), { headers: { "sec-fetch-site": "same-site" } })).status, 403);
  assert.equal(await raw(started.url!, "/__mybuddy/storage", { "x-mybuddy-gadget-token": "bad", "content-type": "application/json" }), 401);
  const slow = sdk.call("blocked");
  await until(async () => await sdk.storage.get("started") === true, "A started");
  assert.equal(await runtime.request(b, "actions/version", { input: null }), "one");
  assert.equal(await slow, "done");
  const previous = storage.readSource(a.id);
  storage.updateSource({ gadgetId: a.id, expectedRevision: previous.revision, files: [{ path: "server/index.mjs", content: source("two") }] }, () => {});
  runtime.sourceChanged(a);
  const changed = await runtime.health(a.id);
  assert.equal(changed.status, "running", changed.error);
  assert.notEqual(changed.pid, started.pid);
  assert.equal(await runtime.request(a, "actions/version", { input: null }), "two");
  const fresh = await client(changed.url!);
  assert.deepEqual(await fresh.storage.get("counter"), { count: 2 });
  assert.equal(await fresh.config.get("theme"), "dark");
  const abort = new AbortController();
  const cancelled = fresh.call("wait", { ms: 400, value: "late" }, { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled);
  const late = fresh.call("lateWrite");
  await until(async () => await fresh.storage.get("late-started") === true, "late action started");
  await assert.rejects(late, /超时|timeout/i);
  await until(async () => {
    try { return await fresh.call("version") === "two"; } catch { return false; }
  }, "host available after late action");
  await until(() => existsSync(join(storage.paths(a.id).dataPath, "late-finished")), "late write attempted");
  await runtime.restart(a);
  const afterLate = await client((await runtime.health(a.id)).url!);
  assert.equal(await afterLate.storage.get("late"), null);
  const noncooperativeHost = await runtime.health(a.id);
  await assert.rejects(afterLate.call("never"), /超时|timeout|停止|fetch/i);
  await until(() => registry.runtime(a.id).status === "error" && !alive(noncooperativeHost.pid!), "noncooperative timeout stops host");
  const processManifest = storage.readManifest(a.id);
  assert(processManifest.backend);
  storage.writeManifest(a.id, { ...processManifest, backend: { ...processManifest.backend, timeoutMs: 10_000 } });
  const restarted = await runtime.start(a);
  assert.equal(restarted.status, "running", restarted.error);
  const again = await client(restarted.url!);
  assert.deepEqual(await again.storage.get("counter"), { count: 2 });
  const running = again.call("spawn").catch(() => null);
  const pidFile = join(storage.paths(a.id).dataPath, "child.pid");
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(existsSync(pidFile), "owned command started");
  const pid = Number(readFileSync(pidFile, "utf8"));
  process.kill(pid, 0);
  await runtime.stop(a.id);
  await running;
  assert.throws(() => process.kill(pid, 0), "stop terminates the owned command");
  rmSync(pidFile, { force: true });
  const crashHost = await runtime.start(a);
  assert.equal(crashHost.status, "running", crashHost.error);
  const crashingClient = await client(crashHost.url!);
  const crashCommand = crashingClient.call("spawn").catch(() => null);
  await until(() => existsSync(pidFile), "command before host crash");
  const crashCommandPid = Number(readFileSync(pidFile, "utf8"));
  assert(alive(crashCommandPid));
  process.kill(crashHost.pid!, "SIGKILL");
  await until(() => registry.runtime(a.id).status === "error" && !alive(crashCommandPid), "host crash command cleanup");
  await crashCommand;
  assert.equal(await runtime.request(a, "actions/version", { input: null }), "two");
  assert.deepEqual(await (await client((await runtime.health(a.id)).url!)).storage.get("counter"), { count: 2 });
  if (currentNodePlatform === "win32") {
    // Windows may reap non-detached children as soon as their host dies. Inject
    // native cleanup failure against an independently owned live fixture instead.
    const owned = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    await once(owned, "spawn");
    assert(owned.pid);
    const systemRoot = process.env.SystemRoot;
    try {
      process.env.SystemRoot = join(root, "no-windows-here");
      await assert.rejects(terminateGadgetCommands([owned.pid]));
      assert(alive(owned.pid), "failed native cleanup leaves the owned process live");
    } finally {
      if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
      await terminateGadgetCommands([owned.pid]);
    }
    assert.equal(alive(owned.pid), false);
    await terminateGadgetCommands([owned.pid]);
    const shims = join(root, "npm shims");
    const script = join(shims, "node_modules", "fixture cli", "run.cjs");
    mkdirSync(join(shims, "node_modules", "fixture cli"), { recursive: true });
    writeFileSync(script, 'process.stdout.write(JSON.stringify({arg:JSON.parse(process.argv[2]),node:process.release.name}));');
    const shim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\fixture cli\\run.cjs" %*\r\n';
    writeFileSync(join(shims, "fixture-cli.cmd"), shim);
    writeFileSync(join(shims, "unsupported-cli.cmd"), 'echo unsafe\r\n' + shim);
    const c = fixture("npm-shim");
    const snapshot = storage.readSource(c.id);
    storage.updateSource({ gadgetId: c.id, expectedRevision: snapshot.revision,
      backend: { entry: "server/index.mjs", commands: ["fixture-cli", "unsupported-cli"] },
      files: [{ path: "server/index.mjs", content: 'export default ctx=>({actions:{run:async input=>{const result=await ctx.exec("fixture-cli",{args:[JSON.stringify(input)]});return JSON.parse(result.stdout)},denied:async()=>ctx.exec("node"),unsupported:async()=>ctx.exec("unsupported-cli")}});' }],
    }, () => {});
    const originalPath = process.env.PATH;
    process.env.PATH = shims;
    try { assert.equal((await runtime.start(c)).status, "running"); }
    finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
    const input = { text: 'quoted "hello" & shell | text', n: 42 };
    assert.deepEqual(await runtime.request(c, "actions/run", { input }), { arg: input, node: "node" });
    await assert.rejects(runtime.request(c, "actions/denied", { input: null }), error => error instanceof Error && "code" in error && error.code === "COMMAND_DENIED");
    await assert.rejects(runtime.request(c, "actions/unsupported", { input: null }), error => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_COMMAND_SHIM");
  }
  await checkProcessBackend();
  console.log("gadget-backend-test: ok");
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await runtime.disposeAll(); } finally { rmSync(root, { recursive: true, force: true }); clearTimeout(deadline); }
});

