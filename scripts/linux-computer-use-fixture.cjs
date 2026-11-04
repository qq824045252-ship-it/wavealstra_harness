"use strict";

// Dedicated acceptance application. It never loads MyBuddy profiles or secrets.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const readline = require("node:readline");

if (!process.env.MYBUDDY_LINUX_FIXTURE_USER_DATA || !process.env.MYBUDDY_LINUX_FIXTURE_TITLE) {
  throw new Error("An isolated userData directory and unique fixture title are required");
}
app.setPath("userData", process.env.MYBUDDY_LINUX_FIXTURE_USER_DATA);
app.commandLine.appendSwitch("force-renderer-accessibility");
const windows = new Map();
let nextId = 0;
const emit = (message) => process.stdout.write(`LINUX_CU_FIXTURE ${JSON.stringify(message)}\n`);

async function createWindow() {
  const id = ++nextId;
  const win = new BrowserWindow({
    width: 900, height: 700, title: process.env.MYBUDDY_LINUX_FIXTURE_TITLE,
    frame: false, show: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  windows.set(id, win);
  win.on("closed", () => windows.delete(id));
  await win.loadFile(path.join(__dirname, "linux-computer-use-fixture.html"));
  win.setTitle(process.env.MYBUDDY_LINUX_FIXTURE_TITLE);
  return { id, pid: process.pid };
}

app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  await createWindow();
  emit({ event: "ready", pid: process.pid, electron: process.versions.electron, node: process.versions.node });
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
      const win = windows.get(message.windowId ?? 1);
      let value;
      switch (message.method) {
        case "snapshot":
          if (!win || win.isDestroyed()) throw new Error("fixture window is closed");
          value = await win.webContents.executeJavaScript("window.fixtureSnapshot()");
          break;
        case "rebuildInput":
          if (!win || win.isDestroyed()) throw new Error("fixture window is closed");
          await win.webContents.executeJavaScript("window.fixtureRebuildInput()");
          value = true;
          break;
        case "resize":
          if (!win || win.isDestroyed()) throw new Error("fixture window is closed");
          win.setSize(940, 710);
          value = true;
          break;
        case "createTwin": value = await createWindow(); break;
        case "closeTwin": windows.get(2)?.close(); value = true; break;
        case "focusTwin": windows.get(2)?.focus(); value = true; break;
        case "quit": emit({ id: message.id, value: true }); app.quit(); return;
        default: throw new Error("unknown fixture RPC");
      }
      emit({ id: message.id, value });
    } catch (error) {
      emit({ id: message?.id, error: String(error?.message ?? error) });
    }
  });
  input.on("close", () => app.quit());
}).catch((error) => { emit({ event: "error", error: error.message }); app.exit(1); });

app.on("window-all-closed", () => app.quit());
