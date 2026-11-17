import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, type Debugger, type WebContents } from "electron";
import { BrowserPageEvents } from "../src/main/capabilities/browser/BrowserPageEvents.ts";

const root = mkdtempSync(join(tmpdir(), "browser-events-"));
app.setPath("userData", join(root, "profile"));
app.setPath("home", root);
const body = "real download bytes 你好";
const server = createServer((req, res) => {
  if (req.url?.startsWith("/file")) { res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=test.txt" }); res.end(body); }
  else { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<button id="download" onclick="location.href='/file?token=private'">Download</button><button id="dialog" onclick="window.answer=confirm('Continue?')">Dialog</button>`); }
});
const guard = setTimeout(() => { console.error("timed out"); app.exit(1); }, 30000);
function protocol(wc: WebContents) {
  const dbg: Debugger = wc.debugger;
  dbg.attach("1.3");
  return {
    get isAttached() { return dbg.isAttached(); },
    protocolCommand: (method: string, params?: unknown, sessionId?: string) => dbg.sendCommand(method, params, sessionId),
    subscribeProtocol: (listener: (method: string, params: unknown, sessionId?: string) => void) => {
      const cb = (_event: Electron.Event, method: string, params: unknown, sessionId: string) => listener(method, params, sessionId);
      dbg.on("message", cb); return () => dbg.off("message", cb);
    },
  };
}
void (async () => {
try {
  await app.whenReady();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const a = new BrowserWindow({ show: false });
  const b = new BrowserWindow({ show: false });
  await Promise.all([a.loadURL(origin), b.loadURL(origin)]);
  const p = protocol(a.webContents);
  const events = new BrowserPageEvents(p, a.webContents, join(root, "downloads"), 5);
  await events.start();
  const scope = { run: <T>(fn: () => Promise<T>) => Promise.race([fn(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("wait timeout")), 5000))]) };
  a.webContents.session.on("will-download", (_event, item, source) => { if (source === b.webContents) item.cancel(); });
  console.log("ready");
  const watch = events.armDownload({ filename: "test.txt" });
  await b.webContents.executeJavaScript(`document.querySelector('#download').click()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  await a.webContents.executeJavaScript(`document.querySelector('#download').click()`);
  console.log("triggered");
  const result = await watch.wait(scope);
  assert.equal(result.state, "completed");
  if (result.state !== "completed") throw new Error("download incomplete");
  assert.equal((await readFile(result.path)).toString(), body);
  assert.equal(result.bytes, Buffer.byteLength(body));
  assert.equal(result.sha256, createHash("sha256").update(body).digest("hex"));
  assert(!result.url.includes("private"));
  const responseWatch = events.armResponse({ urlIncludes: "/?", status: 200 });
  responseWatch.cancel();
  const response = events.armResponse({ status: 200 });
  await a.webContents.executeJavaScript(`fetch('/?token=private')`);
  assert.equal((await response.wait(scope)).status, 200);
  const pending = a.webContents.executeJavaScript(`document.querySelector('#dialog').click()`);
  for (let i = 0; i < 100 && !events.currentDialog(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const dialog = events.currentDialog(); assert(dialog);
  await assert.rejects(events.answerDialog("wrong-id", { action: "accept" }));
  await events.answerDialog(dialog.id, { action: "dismiss" });
  await pending;
  assert.equal(await a.webContents.executeJavaScript("window.answer"), false);
  events.setDialogRules([{ type: "confirm", answer: { action: "accept" } }]);
  await a.webContents.executeJavaScript(`document.querySelector('#dialog').click()`);
  assert.equal(await a.webContents.executeJavaScript("window.answer"), true);
  await a.webContents.executeJavaScript(`console.log('token=private https://example.test/?secret=private')`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const trace = events.snapshot(0);
  assert(trace.events.some(event => event.kind === "console"));
  assert(!JSON.stringify(trace).includes("private"));
  const cancelled = events.armDownload();
  const cancelledWait = cancelled.wait(scope);
  cancelled.cancel();
  await assert.rejects(cancelledWait, /cancelled/);
  await a.webContents.executeJavaScript(`for (let i=0;i<8;i++) console.log('entry '+i)`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const bounded = events.snapshot(0);
  assert.equal(bounded.events.length, 5);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(events.snapshot(bounded.cursor).events, []);
  events.dispose();
  assert(p.isAttached, "module must not detach inspector");
  a.destroy(); b.destroy();
  console.log("PASS real Electron: pinned download, hash, dialog, redaction, inspector ownership");
  clearTimeout(guard); server.close(); app.exit(0);
} catch (error) { console.error(error); clearTimeout(guard); server.close(); app.exit(1); }


})();



