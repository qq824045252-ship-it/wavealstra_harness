"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { findPackagedExecutable } = require("./verify-packaged-app.cjs");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const appDirArg = value("--app-dir");
const appDir = appDirArg ? path.resolve(appDirArg) : undefined;
const reportDir = path.resolve(value("--report-dir") || process.env.MYBUDDY_LINUX_CU_TEST_OUT ||
  path.join(root, "out/tests/linux-computer-use", `${new Date().toISOString().replace(/[:.]/g, "-")}-${appDir ? "packaged" : "dev"}`));
fs.mkdirSync(reportDir, { recursive: true });
const report = { mode: appDir ? "packaged-main" : "development-backend", startedAt: new Date().toISOString(), status: "running", reportDir };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function waitFor(check, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}

/** Run the shipped acceptance module inside the normal, isolated packaged main process. */
async function runPackagedAcceptance(executable, entry, fixtureExecutable) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mybuddy-linux-package-"));
  const agentDir = path.join(profile, ".mybuddy");
  fs.mkdirSync(path.join(agentDir, "plugins/mcp"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false }));
  fs.writeFileSync(path.join(agentDir, "plugins/mcp/mcp.json"), '{"mcpServers":{}}');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = {
    ...process.env, HOME: profile, USERPROFILE: profile, PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: path.join(profile, ".config"),
    MYBUDDY_LINUX_FIXTURE_ELECTRON: fixtureExecutable,
    MYBUDDY_LINUX_CU_REPORT_DIR: reportDir,
    MYBUDDY_LINUX_CU_MODE: "packaged-main",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const logFd = fs.openSync(path.join(reportDir, "packaged-startup.log"), "w");
  const child = spawn(executable, [
    `--inspect=127.0.0.1:${port}`, `--user-data-dir=${path.join(profile, "chromium")}`, "--ozone-platform=wayland",
  ], { env, cwd: profile, stdio: ["ignore", logFd, logFd] });
  let socket;
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const pending = new Map();
  let sequence = 0;
  const evaluate = (expression, timeout = 30_000) => new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error("packaged main inspector is not connected")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("packaged main inspector timeout")); }, timeout);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  try {
    const target = await waitFor(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode) throw new Error("packaged app exited before its renderer was ready");
      try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "node"); }
      catch { return undefined; }
    }, "normal packaged Electron main process");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = (event) => {
      const response = JSON.parse(event.data);
      const request = pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(response.id);
      if (response.error || response.result?.exceptionDetails) {
        request.reject(new Error(JSON.stringify(response.error ?? response.result.exceptionDetails)));
      } else request.resolve(response.result?.result?.value);
    };
    socket.onclose = () => {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("packaged main inspector closed")); }
      pending.clear();
    };
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode) throw new Error("packaged app exited before its main module initialized");
      return evaluate("Boolean(process.mainModule && typeof process.mainModule.require === 'function')", 2_000);
    }, "packaged Electron main module initialization");
    const identity = await evaluate(`(async()=>{
      const req=process.mainModule.require.bind(process.mainModule);
      const {app,BrowserWindow}=req('electron'); await app.whenReady();
      if(req('node:os').homedir()!==${JSON.stringify(profile)} || !app.getPath('userData').startsWith(${JSON.stringify(profile)}))throw Error('Profile isolation failed');
      const end=Date.now()+30000;
      while(Date.now()<end){
        const win=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().includes('index.html')&&!w.webContents.isLoadingMainFrame());
        if(win)return {pid:process.pid,packaged:app.isPackaged,version:app.getVersion(),node:process.versions.node,electron:process.versions.electron,executable:process.execPath,processType:process.type,nodeMode:process.env.ELECTRON_RUN_AS_NODE==='1',userData:app.getPath('userData'),rendererUrl:win.webContents.getURL(),wayland:Boolean(process.env.WAYLAND_DISPLAY),dbus:Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)};
        await new Promise(r=>setTimeout(r,100));
      }
      throw Error('Packaged renderer did not load');
    })()`);
    assert.equal(identity.pid, child.pid);
    assert.equal(identity.packaged, true);
    assert.equal(identity.processType, "browser");
    assert.equal(identity.nodeMode, false);
    assert.equal(identity.wayland, true);
    assert.equal(identity.dbus, true);
    const runtimeManifest = JSON.parse(fs.readFileSync(path.join(appDir, "resources/app.asar.unpacked/out/main/linux-computer-use-runtime.json"), "utf8"));
    assert.equal(identity.version, runtimeManifest.appVersion);
    report.packagedStartup = identity;
    const accepted = await evaluate(`(async()=>{
      if(process.env.ELECTRON_RUN_AS_NODE==='1'||process.type!=='browser')throw Error('Expected the normal packaged main process');
      const req=process.mainModule.require.bind(process.mainModule);
      const suite=req(${JSON.stringify(entry)});
      if(!suite.acceptanceRun||typeof suite.acceptanceRun.then!=='function')throw Error('Packaged acceptance export is missing');
      return await suite.acceptanceRun;
    })()`, 600_000);
    report.packagedAcceptance = {
      status: accepted?.status, mode: accepted?.mode, runtime: accepted?.runtime,
      tests: accepted?.tests?.map(({ name, status }) => ({ name, status })),
    };
    assert.equal(accepted?.runtime?.pid, identity.pid, "GUI input and D-Bus must run inside the normal packaged main process");
    assert.equal(accepted?.runtime?.nodeMode, false);
    assert.equal(accepted?.runtime?.processType, "browser");
    assert.equal(accepted?.runtime?.executable, identity.executable);
    assert.equal(accepted?.mode, "packaged-main");
    assert.equal(accepted?.status, "passed", `Packaged GUI acceptance failed; see ${reportDir}/acceptance-report.json`);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      await evaluate("setTimeout(()=>process.mainModule.require('electron').app.quit(),50);true", 2_000).catch(() => undefined);
    }
    socket?.close();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("packaged acceptance closed")); }
    pending.clear();
    for (let i = 0; i < 25 && child.exitCode === null && !child.signalCode; i += 1) await pause(100);
    if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
    for (let i = 0; i < 20 && child.exitCode === null && !child.signalCode; i += 1) await pause(100);
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    for (let i = 0; i < 10 && child.exitCode === null && !child.signalCode; i += 1) await pause(100);
    fs.closeSync(logFd);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  assert.equal(process.platform, "linux", "The Linux GUI gate requires Linux and does not return a skip/pass");
  for (const name of ["WAYLAND_DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "DBUS_SESSION_BUS_ADDRESS"]) {
    assert.ok(process.env[name], `Missing ${name}: run from the actual Hyprland user graphical session`);
  }
  const fixtureExecutable = path.resolve(value("--fixture-electron") || process.env.MYBUDDY_LINUX_FIXTURE_ELECTRON || require("electron"));
  assert.ok(fs.existsSync(fixtureExecutable), "The pinned Electron fixture runtime is missing");
  const appExeName = appDir ? findPackagedExecutable(appDir, "linux") : undefined;
  if (appDir) assert.ok(appExeName, "The packaged application executable is missing");
  const executable = appDir ? path.join(appDir, appExeName) : fixtureExecutable;
  const assetRoot = appDir ? path.join(appDir, "resources/app.asar.unpacked/out/main") : path.join(root, "out/main");
  const entry = path.join(assetRoot, "linux-computer-use-acceptance.cjs");
  for (const name of ["linux-computer-use-acceptance.cjs", "atspi-worker.cjs", "input-guardian.cjs", "linux-computer-use-fixture.cjs", "linux-computer-use-fixture.html"]) {
    assert.ok(fs.existsSync(path.join(assetRoot, name)), `Missing acceptance payload ${name}; build/package first`);
  }
  report.executable = executable;
  report.executableSha256 = digest(executable);
  report.acceptanceSha256 = digest(entry);
  report.workerSha256 = digest(path.join(assetRoot, "atspi-worker.cjs"));
  report.fixtureExecutable = fixtureExecutable;
  report.fixtureRuntime = "separate pinned Electron; version equality is checked by the GUI suite";
  if (appDir) {
    await runPackagedAcceptance(executable, entry, fixtureExecutable);
    report.status = "passed";
    return;
  }
  const child = spawn(executable, [entry], {
    cwd: root,
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: "1",
      MYBUDDY_LINUX_FIXTURE_ELECTRON: fixtureExecutable,
      MYBUDDY_LINUX_CU_REPORT_DIR: reportDir,
      MYBUDDY_LINUX_CU_MODE: report.mode,
    },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exit, signal) => signal ? reject(new Error(`GUI acceptance terminated by ${signal}`)) : resolve(exit));
  });
  assert.equal(code, 0, `Linux GUI acceptance failed (exit ${code}); see ${reportDir}`);
  report.status = "passed";
}

main().catch((error) => {
  report.status = "failed";
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
  console.error(`[linux-computer-use] FAIL ${error.message}`);
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(reportDir, "runner-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`[linux-computer-use] report: ${reportDir}`);
});
