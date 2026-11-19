const { app, BrowserWindow } = require("electron");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const home = mkdtempSync(join(tmpdir(), "mybuddy-chat-resync-"));
process.env.HOME = process.env.USERPROFILE = home;
app.setPath("home", home);
app.setPath("userData", join(home, "chromium"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", event => {
    if (event.level === "error") errors.push(event.sourceId + " " + event.message);
  });
  try {
    const bundle = "chat-resync-desktop-fixture";
    const asset = extension => pathToFileURL(resolve("out/tests", bundle + extension)).href;
    const page = join(home, "chat.html");
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${asset(".css")}">
      <div id="root" style="height:100vh;display:flex"></div><script src="${asset(".js")}"></script>`);
    await win.loadFile(page);
    const result = await win.webContents.executeJavaScript("ChatResync.verify()");
    if (errors.length) throw Error(errors.join("\n"));
    console.log("PASS ChatView", result);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win.destroy(); app.exit(process.exitCode || 0); }
});
