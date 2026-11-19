const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const out = path.join(root, "out", "tests", "pstack-settings-ui");

async function renderer() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  app.setPath("userData", path.join(process.env.USERPROFILE, "chromium"));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const { ModeProfileStore } = require(path.join(out, "store.cjs"));
  const store = new ModeProfileStore();
  let host = { revision: "0", maxParallelTasks: 12, maxConcurrency: 3,
    globalDefaultModelId: "fixture/alpha", roles: { diverse: ["fixture/alpha", "mirror/alpha"], fast: ["fixture/alpha"] } };
  ipcMain.handle("profile", (_event, mode) => store.getProfile(mode));
  ipcMain.handle("save", (_event, mode, policy, section) => store.savePolicy(mode, policy, section));
  ipcMain.handle("host", () => host);
  ipcMain.handle("save-host", (_event, patch) => {
    if (patch.expectedRevision !== host.revision) throw Error("stale host settings");
    const { expectedRevision, ...changes } = patch;
    host = { ...host, ...changes, revision: String(Number(expectedRevision) + 1) };
    return host;
  });
  const win = new BrowserWindow({ width: 1120, height: 800, show: false, webPreferences: {
    preload: path.join(out, "preload.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } });
  await win.loadURL("about:blank");
  await win.webContents.insertCSS(fs.readFileSync(path.join(out, "ui.css"), "utf8"));
  const result = await win.webContents.executeJavaScript(fs.readFileSync(path.join(out, "ui.js"), "utf8") + "\nPstackUI.run()");
  console.log(result);
  const [width, height] = win.getContentSize();
  win.setContentSize(width + 1, height);
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const screenshot = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(out, "settings.png"), screenshot.toPNG());
  const physical = new ModeProfileStore().getProfile("coding");
  if (physical.policy.pstackThermosEnabled || physical.policy.pstackThermos?.thermos.changedLines !== 37) throw Error("Disabled profile lost its saved parameters");
  if (host.maxParallelTasks !== 8 || host.maxConcurrency !== 2 || !host.roles.diverse.includes("fixture/beta")) throw Error("Missing global configuration edits");
  console.log(await win.webContents.executeJavaScript("PstackUI.resetAndVerify()"));
  win.destroy();
  app.exit(0);
}

async function main() {
  if (process.versions.electron) {
    const timeout = setTimeout(() => require("electron").app.exit(1), 60_000);
    try { await renderer(); } finally { clearTimeout(timeout); }
    return;
  }
  const { build } = require("esbuild");
  fs.mkdirSync(out, { recursive: true });
  await Promise.all([
    build({ entryPoints: [path.join(__dirname, "pstack-settings-ui-fixture.tsx")], bundle: true, outfile: path.join(out, "ui.js"),
      platform: "browser", format: "iife", globalName: "PstackUI", jsx: "automatic",
      alias: { "@": path.join(root, "src", "renderer", "src"), "@shared": path.join(root, "src", "shared") },
      loader: Object.fromEntries([".png", ".svg", ".woff", ".woff2", ".ttf"].map(ext => [ext, "dataurl"])),
    }),
    build({ entryPoints: [path.join(root, "src", "main", "agent", "ModeProfileStore.ts")], bundle: true, platform: "node",
      format: "cjs", external: ["electron"], outfile: path.join(out, "store.cjs") }),
  ]);
  fs.writeFileSync(path.join(out, "preload.cjs"), `const {contextBridge, ipcRenderer} = require("electron");
    contextBridge.exposeInMainWorld("api",{agent:{
      getModeProfile: id=>ipcRenderer.invoke("profile",id),saveModePolicy:(id,p,section)=>ipcRenderer.invoke("save",id,p,section),
      getAppSettings: async()=>({}),listModeProfiles:async()=>[],listSkills:async()=>[],listExperts:async()=>[],
      getSubagentConfig:()=>ipcRenderer.invoke("host"),saveSubagentConfig:patch=>ipcRenderer.invoke("save-host",patch),
      listModels:async()=>["fixture/alpha","mirror/alpha","fixture/beta"].map(id=>({id,name:id,available:true,enabled:true}))
    }});`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mybuddy-pstack-settings-"));
  const temp = key => path.join(home, key);
  for (const dir of ["chromium", "appdata", "localappdata"]) fs.mkdirSync(temp(dir));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: temp("appdata"), LOCALAPPDATA: temp("localappdata") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawnSync(require("electron"), [__filename, "--user-data-dir=" + temp("chromium")], { env, stdio: "inherit", windowsHide: true, timeout: 85_000 });
    if (child.error) throw child.error;
    if (child.status !== 0) throw Error("Pstack settings Electron test failed: " + (child.status ?? child.signal));
  } finally {
    fs.rmSync(home, { force: true, recursive: true, maxRetries: 3 });
  }
}
main().catch(error => { console.error(error); if (process.versions.electron) require("electron").app.exit(1); else process.exitCode = 1; });
