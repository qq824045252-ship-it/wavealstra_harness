import { app, BrowserWindow, ipcMain } from "electron";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { BrowserHost } from "../src/main/browser/BrowserHost";
const output = join(process.cwd(), "out/diagnostics/browser-tabs-ui"); mkdirSync(output, { recursive: true });
app.setPath("userData", join(mkdtempSync(join(output, "profile-")), "data"));
app.on("window-all-closed", () => {});
let sourceVersion = 1;
const server = createServer((req,res) => { res.setHeader("content-type","text/html"); res.end(`<title>${req.url}</title><input id="draft"><p>${req.url}</p><script>window.renderVersion=${sourceVersion};window.created=Math.random()</script>`); });
const host = new BrowserHost(() => true);
let win: BrowserWindow | undefined, error: unknown;
const guard = setTimeout(() => { console.error("BrowserView UI test timed out"); app.exit(1); }, 30_000);
void (async () => {
 await app.whenReady(); await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
 win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { nodeIntegration: true, contextIsolation: false } });
 win.webContents.on("console-message", event => { if (event.level === "error") console.error("renderer:", event.message); });
 await win.loadURL("about:blank"); host.attach(win);
 host.onTabsChanged = state => { if (win && !win.isDestroyed()) win.webContents.send("tabs-state",state); };
 ipcMain.handle("tabs-test", async (_e,method: string,...args: unknown[]) => {
   if (method === "markGadgetUpdated") { sourceVersion++; host.markGadgetUpdated(args[0] as string); return; }
   if (method === "eval") return host.getTabHost(args[0] as string)!.inspectionWebContents!.executeJavaScript(args[1] as string);
   const allowed = ["getTabsState","open","ensureTab","selectTab","closeTab","hide","close","setBounds","navigate","hardReload","navigateForAutomation"];
   if (!allowed.includes(method)) throw new Error("Unknown fixture method");
   return (host as any)[method](...args);
 });
 const bundle = readFileSync(join(process.cwd(),"out/tests/browser-tabs-ui-fixture.js"),"utf8");
 const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const checks = await win.webContents.executeJavaScript(bundle + `\nBrowserTabsUi.run(${JSON.stringify(base)})`);
 writeFileSync(join(output,"results.json"),JSON.stringify({checks},null,2));
 for (const check of checks) console.log("PASS",check);
})().catch(e => { error = e; console.error(e); }).finally(() => { host.dispose(); win?.destroy(); server.close(); clearTimeout(guard); app.exit(error ? 1 : 0); });
