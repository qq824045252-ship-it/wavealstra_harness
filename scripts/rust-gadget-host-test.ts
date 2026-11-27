import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetService } from "../src/main/gadget/GadgetService";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import type { GadgetClient } from "../src/shared/gadget-backend";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit, RuntimeAuditReader } from "../src/main/platform/runtime-audit";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function sdkClient(url: string): Promise<GadgetClient> {
  const sdk = await (await fetch(new URL("__mybuddy/sdk.js", url))).text();
  const window: { gadget?: GadgetClient } = {};
  runInNewContext(sdk, {
    window,
    document: { addEventListener() {} },
    location: { origin: new URL(url).origin },
    fetch,
    Element: class {},
  });
  assert(window.gadget, "window.gadget must be installed by sdk.js");
  return window.gadget;
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

function ensureRustToolchainEnv(): void {
  const cargoBin = findExecutable("cargo") ?? findExecutable("rustc");
  if (cargoBin) {
    const binDir = join(cargoBin, "..");
    const dotCargo = join(binDir, "..");
    if (existsSync(join(dotCargo, "bin"))) {
      process.env.CARGO_HOME ??= dotCargo;
      const maybeRustup = join(dotCargo, "..", ".rustup");
      if (existsSync(maybeRustup)) process.env.RUSTUP_HOME ??= maybeRustup;
    }
  }
}

async function main(): Promise<void> {
  const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
  assert(executable && existsSync(executable), "Rust runtime-audit executable is required");

  ensureRustToolchainEnv();
  const root = mkdtempSync(join(tmpdir(), "mybuddy-rust-gadget-host-"));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const dataDir = join(root, ".mybuddy");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "app.duckdb");

  const reader = new RuntimeAuditReader(executable, dbPath, { coreDataDirectory: dataDir, coreRole: "ui" });
  let runtime: GadgetRuntime | undefined;
  let coreClient: CoreBusinessClient | undefined;

  try {
    const repository = new GadgetRepository({ core: reader });
    const storage = new GadgetStorage(join(dataDir, "gadgets"), reader);
    const registry = new GadgetRegistry();
    runtime = new GadgetRuntime(storage, registry, undefined, reader, { idleTimeoutMs: 180 });
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

    coreClient = await CoreBusinessClient.connect(executable, dbPath, {
      dataDirectory: dataDir,
      role: "background-service",
      clientId: "rc17-svc",
    });

    // -------------------------------------------------------------------------
    // RC-17: 0, 1, 10, 20 static Gadgets -> 0 dedicated Node HTTP processes
    // -------------------------------------------------------------------------
    const staticIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const desc = await service.createAsync({
        name: `Static-${i}`,
        scope: { type: "global" },
        defaultConfig: { theme: `theme-${i}` },
        files: [
          { path: "index.html", content: `<!doctype html><html><head></head><body><h1>Static ${i}</h1></body></html>` },
          { path: ".env", content: "SECRET=deny" },
        ],
      });
      staticIds.push(desc.id);
    }

    const assertStaticCount = async (count: number) => {
      assert.equal(runtime!.activeProcessCount(), 0, `expected 0 Node processes at count=${count}`);
      assert.equal(runtime!.trackedPids().length, 0, `expected 0 tracked child PIDs at count=${count}`);
      const list = await coreClient!.gadgetHost<{ staticHosts: Array<{ gadgetId: string; status: string }>; backends: unknown[] }>({
        action: "list",
      });
      assert.equal(list.staticHosts.filter(h => h.status === "running").length, count);
      assert.equal(list.backends.length, 0);
    };

    await assertStaticCount(0);

    // Open 1
    const s0 = await service.start(staticIds[0]);
    assert.equal(s0.status, "running");
    assert.equal(s0.hostKind, "rust-shared");
    assert.equal(s0.pid, undefined);
    await assertStaticCount(1);

    // Verify HTML + SDK injection + security + storage/config via Rust Shared Host
    const htmlRes = await fetch(s0.url!);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /<script src="\/__mybuddy\/sdk\.js"><\/script>/);
    assert.equal((await fetch(new URL(".env", s0.url!))).status, 404);
    const sdk0 = await sdkClient(s0.url!);
    assert.equal(await sdk0.config.get("theme"), "theme-0");
    await sdk0.storage.set("counter", 77, null);
    assert.equal(await sdk0.storage.get("counter"), 77);

    // Open up to 10 concurrently
    await Promise.all(staticIds.slice(1, 10).map(id => service.start(id)));
    await assertStaticCount(10);

    // Open up to 20 concurrently
    await Promise.all(staticIds.slice(10, 20).map(id => service.start(id)));
    await assertStaticCount(20);

    // Verify each of the 20 serves distinct page & isolated storage
    for (let i = 0; i < 20; i += 1) {
      const state = registry.runtime(staticIds[i]);
      assert.equal(state.status, "running");
      assert.equal(state.hostKind, "rust-shared");
      const sdk = await sdkClient(state.url!);
      assert.equal(await sdk.config.get("theme"), `theme-${i}`);
    }

    // Close one by one and reopen subset -> always 0 dedicated Node processes
    for (const id of staticIds) {
      const stopped = await service.stop(id);
      assert.equal(stopped.status, "stopped");
    }
    await assertStaticCount(0);
    await fetch(s0.url!).then(
      () => { throw new Error("Stopped static host URL must refuse connections"); },
      () => undefined,
    );

    const reopened0 = await service.start(staticIds[0]);
    assert.equal(reopened0.status, "running");
    assert.equal(reopened0.hostKind, "rust-shared");
    assert.equal(await (await sdkClient(reopened0.url!)).storage.get("counter"), 77);
    await service.stop(staticIds[0]);
    await assertStaticCount(0);
    console.log("PASS RC-17: 0/1/10/20 static Gadgets served by Shared Rust HTTP Host with 0 dedicated Node processes");

    // -------------------------------------------------------------------------
    // RC-18: Node/Python/Go/Rust backends — readonly no-start, single-flight first call,
    //        idle vs in-flight, descendant exit tracking, crash/restart, missing runtime blocked
    // -------------------------------------------------------------------------
    const nodeDesc = await service.createAsync({
      name: "Node Backend",
      scope: { type: "global" },
      backend: { entry: "server/index.mjs", commands: ["node"], timeoutMs: 2_000 },
      files: [
        { path: "index.html", content: "<html><body>node</body></html>" },
        {
          path: "server/index.mjs",
          content: `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
export default async function(ctx) {
  return { actions: {
    ping: async (input) => ({ lang: "node", pid: process.pid, input }),
    slow: async (ms) => { await new Promise(r => setTimeout(r, Number(ms) || 260)); return { ok: true, pid: process.pid }; },
    spawnChild: async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      await new Promise(resolve => child.once("spawn", resolve));
      writeFileSync(ctx.dataPath + "/descendant.pid", String(child.pid));
      return child.pid;
    },
    crash: async () => { process.exit(19); },
  } };
}`,
        },
      ],
    });

    const pythonCmd = hasCommand("python", ["--version"]) ? "python" : hasCommand("python3", ["--version"]) ? "python3" : undefined;
    assert(pythonCmd, "Python runtime expected on host");
    const pyScript = `
import json, os, sys
print(json.dumps({"type": "ready", "version": 1, "actions": ["ping", "slow"]}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    t = msg.get("type")
    if t == "shutdown":
        sys.exit(0)
    if t == "call":
        act = msg.get("action")
        if act == "ping":
            print(json.dumps({"type": "result", "id": msg["id"], "value": {"lang": "python", "pid": os.getpid(), "input": msg.get("input")}}), flush=True)
        elif act == "slow":
            import time
            time.sleep(0.25)
            print(json.dumps({"type": "result", "id": msg["id"], "value": {"ok": True, "pid": os.getpid()}}), flush=True)
`;
    const pyDesc = await service.createAsync({
      name: "Python Backend",
      scope: { type: "global" },
      backend: { kind: "process", command: pythonCmd, args: ["-u", "worker.py"], cwd: "server", timeoutMs: 3_000 },
      files: [
        { path: "index.html", content: "<html><body>py</body></html>" },
        { path: "server/worker.py", content: pyScript },
      ],
    });

    const buildRoot = join(root, "compiled-backends");
    mkdirSync(buildRoot, { recursive: true });
    assert(hasCommand("go", ["version"]), "Go runtime expected on host");
    const goExe = findExecutable("go") ?? "go";
    const goSrc = join(buildRoot, "worker.go");
    const goBin = join(buildRoot, process.platform === "win32" ? "worker-go.exe" : "worker-go");
    writeFileSync(goSrc, `package main
import (
  "bufio"
  "encoding/json"
  "fmt"
  "os"
)
func main() {
  fmt.Println(\`{"type":"ready","version":1,"actions":["ping"]}\`)
  sc := bufio.NewScanner(os.Stdin)
  pid := os.Getpid()
  for sc.Scan() {
    var msg map[string]any
    if err := json.Unmarshal([]byte(sc.Text()), &msg); err != nil { continue }
    if msg["type"] == "shutdown" { os.Exit(0) }
    if msg["type"] == "call" && msg["action"] == "ping" {
      out, _ := json.Marshal(map[string]any{"type": "result", "id": msg["id"], "value": map[string]any{"lang": "go", "pid": pid, "input": msg["input"]}})
      fmt.Println(string(out))
    }
  }
}`);
    execFileSync(goExe, ["build", "-o", goBin, goSrc], {
      stdio: "pipe",
      windowsHide: true,
      shell: /\.(?:cmd|bat)$/i.test(goExe),
    });
    const goDesc = await service.createAsync({
      name: "Go Backend",
      scope: { type: "global" },
      backend: { kind: "process", command: goBin, args: [], cwd: ".", timeoutMs: 3_000 },
      files: [{ path: "index.html", content: "<html><body>go</body></html>" }],
    });

    assert(hasCommand("rustc", ["--version"]), "Rust compiler expected on host");
    const rustcExe = findExecutable("rustc") ?? "rustc";
    const rsSrc = join(buildRoot, "worker.rs");
    const rsBin = join(buildRoot, process.platform === "win32" ? "worker-rs.exe" : "worker-rs");
    writeFileSync(rsSrc, `
use std::io::{self, BufRead, Write};
fn main() {
    println!("{{\\"type\\":\\"ready\\",\\"version\\":1,\\"actions\\":[\\"ping\\"]}}");
    let _ = io::stdout().flush();
    let pid = std::process::id();
    let stdin = io::stdin();
    for line in stdin.lock().lines().flatten() {
        if line.contains("\\"shutdown\\"") { std::process::exit(0); }
        if line.contains("\\"call\\"") {
            let id_pos = line.find("\\"id\\":").map(|i| &line[i+5..]).unwrap_or("1");
            let id_str: String = id_pos.chars().skip_while(|c| c.is_whitespace()).take_while(|c| c.is_ascii_digit()).collect();
            println!("{{\\"type\\":\\"result\\",\\"id\\":{id_str},\\"value\\":{{\\"lang\\":\\"rust\\",\\"pid\\":{pid}}}}}", id_str = id_str, pid = pid);
            let _ = io::stdout().flush();
        }
    }
}`);
    execFileSync(rustcExe, [rsSrc, "-o", rsBin], { stdio: "pipe", windowsHide: true });
    const rsDesc = await service.createAsync({
      name: "Rust Backend",
      scope: { type: "global" },
      backend: { kind: "process", command: rsBin, args: [], cwd: ".", timeoutMs: 3_000 },
      files: [{ path: "index.html", content: "<html><body>rs</body></html>" }],
    });

    // Read-only list / read / health / host list NEVER implicitly starts any backend!
    const listAll = await service.readList();
    assert(listAll.length >= 24);
    for (const desc of [nodeDesc, pyDesc, goDesc, rsDesc]) {
      const readItem = await service.read(desc.id);
      assert.equal(readItem?.runtime.status, "stopped");
      assert.equal((await runtime.health(desc.id)).status, "stopped");
    }
    assert.equal(runtime.activeProcessCount(), 0, "readonly queries must spawn 0 backend processes");

    // Concurrent first invoke spawns ONLY 1 backend per instance across all 4 runtimes (Node/Python/Go/Rust)
    for (const [label, desc, expectedLang] of [
      ["node", nodeDesc, "node"],
      ["python", pyDesc, "python"],
      ["go", goDesc, "go"],
      ["rust", rsDesc, "rust"],
    ] as const) {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, idx) => runtime!.request(desc, "actions/ping", { input: idx }) as Promise<{ lang: string; pid: number }>),
      );
      assert.equal(results.length, 8);
      assert(results.every(r => r.lang === expectedLang), `${label} backend responses match`);
      assert.equal(new Set(results.map(r => r.pid)).size, 1, `${label} concurrent first calls share single backend instance`);
    }

    // Idle reclaim MUST wait for in-flight call, then reclaim cleanly after idle timeout
    const pySlow = runtime.request(pyDesc, "actions/slow", { input: 280 }) as Promise<{ ok: boolean; pid: number }>;
    await new Promise(r => setTimeout(r, 40));
    const reclaimedDuringFlight = await runtime.reclaimIdle(Date.now() + 10_000);
    assert(!reclaimedDuringFlight.includes(pyDesc.id), "idle reclaim must not interrupt active in-flight call");
    const pySlowRes = await pySlow;
    assert.equal(pySlowRes.ok, true);

    await until(() => registry.runtime(pyDesc.id).status === "stopped", "python backend idle reclaimed");
    assert.equal(registry.runtime(pyDesc.id).diagnostics?.idleReclaimed, true);
    assert.equal(alive(pySlowRes.pid), false, "reclaimed python backend process exited");

    // Stop all except nodeDesc so we test descendant cleanup + crash + restart on nodeDesc
    await runtime.stop(goDesc.id);
    await runtime.stop(rsDesc.id);

    // Wait for nodeDesc idle reclaim or test fresh invoke after reclaim
    await until(() => registry.runtime(nodeDesc.id).status === "stopped", "node backend idle reclaimed cleanly");
    const descPid = await runtime.request(nodeDesc, "actions/spawnChild", { input: null }) as number;
    assert(alive(descPid), "spawned descendant must be alive");
    await runtime.restart(nodeDesc);
    await until(() => !alive(descPid), "restart reaps descendant process tree");

    // Crash recovery
    await assert.rejects(runtime.request(nodeDesc, "actions/crash", { input: null }));
    await until(() => registry.runtime(nodeDesc.id).status === "error", "crash transitions runtime to error");
    const pingAfterCrash = await runtime.request(nodeDesc, "actions/ping", { input: 99 }) as { lang: string };
    assert.equal(pingAfterCrash.lang, "node");
    await runtime.stop(nodeDesc.id);

    // Missing runtime environment explicitly blocked
    const missingDesc = await service.createAsync({
      name: "Missing Runtime",
      scope: { type: "global" },
      backend: { kind: "process", command: "nonexistent-mybuddy-python-go-runtime", args: [], cwd: ".", timeoutMs: 1_000 },
      files: [{ path: "index.html", content: "<html><body>missing</body></html>" }],
    });
    const missingState = await runtime.start(missingDesc);
    assert.equal(missingState.status, "error");
    assert.equal(missingState.blocked, true, "missing runtime must report explicit blocked=true");
    assert.equal(missingState.code, "RUNTIME_ENVIRONMENT_MISSING");
    assert.equal(runtime.activeProcessCount(), 0);
    console.log("PASS RC-18: Node/Python/Go/Rust backends lazy single-flight, in-flight idle fence, descendant cleanup, crash/restart, missing runtime blocked");

    // -------------------------------------------------------------------------
    // RC-19: UI disconnect does not revoke running background/static instance;
    //        explicit stop/revoke fences late writes before atomic rename commit
    // -------------------------------------------------------------------------
    const rc19Static = staticIds[1];
    const startedStatic = await service.start(rc19Static);
    assert.equal(startedStatic.status, "running");

    let uiClient: CoreBusinessClient | undefined;
    let genRc19: string | undefined;
    try {
      uiClient = await CoreBusinessClient.connect(executable, dbPath, {
        dataDirectory: dataDir,
        role: "ui",
        clientId: "rc19-ui",
      });
      const beforeUiDrop = await coreClient!.gadgetHost<{ staticHosts: Array<{ gadgetId: string; generation: string }> }>({
        action: "list",
      });
      genRc19 = beforeUiDrop.staticHosts.find(h => h.gadgetId === rc19Static)?.generation;
      assert(genRc19, "static host generation must exist in Core");

      // Perform an ephemeral read through UI client then drop UI connection!
      await uiClient.gadgetHost({ action: "health", gadgetId: rc19Static });
      const staticDataPath = storage.paths(rc19Static).dataPath;
      const openedState = await uiClient.request<{ kind: string; canonicalPath: string }>({
        operation: "gadgetState",
        request: { kind: "open", path: staticDataPath },
      });
      assert.equal(openedState.kind, "opened");
    } finally {
      await uiClient?.close().catch(() => undefined); // UI exits/disconnects!
    }
    assert(genRc19, "static host generation must exist in Core");
    const staticDataPath = storage.paths(rc19Static).dataPath;

    // Instance MUST remain alive and legitimate writes under its generation MUST succeed!
    const sdk19 = await sdkClient(startedStatic.url!);
    await sdk19.storage.set("aliveAfterUiClose", "yes", null);
    assert.equal(await sdk19.storage.get("aliveAfterUiClose"), "yes");
    assert.equal(registry.runtime(rc19Static).status, "running");

    // Now explicit stop revokes genRc19 -> late write MUST fail closed (STALE_WRITE) without touching disk!
    await service.stop(rc19Static);
    const lateReply = await reader.accessGadgetState(
      staticDataPath,
      realpathSync(staticDataPath),
      "storage",
      { operation: "set", key: Array.from("aliveAfterUiClose", c => c.charCodeAt(0)), valueJson: JSON.stringify("CORRUPT"), writeId: crypto.randomUUID() },
      { generation: genRc19, invocationId: "late-invocation", expiresAt: 0 },
      () => false,
    );
    assert.deepEqual(lateReply, { kind: "error", error: "STALE_WRITE" }, "revoked instance generation must fail closed before commit");
    const persistedJson = JSON.parse(readFileSync(join(staticDataPath, ".mybuddy-state.json"), "utf8")) as {
      storage: { aliveAfterUiClose?: { value: string } };
    };
    assert.equal(persistedJson.storage.aliveAfterUiClose?.value, "yes", "late write never modified disk");

    console.log("PASS RC-19: UI disconnect preserves live Gadget instance; stop revokes generation before commit");
    console.log("PASS RC-17..RC-19 rust-gadget-host complete");
  } finally {
    await coreClient?.close().catch(() => undefined);
    await runtime?.disposeAll().catch(() => undefined);
    await reader.close().catch(() => undefined);
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* ignore */ }
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
