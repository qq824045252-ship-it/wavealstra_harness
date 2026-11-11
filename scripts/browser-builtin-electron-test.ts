import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { app, BrowserWindow, shell } from "electron";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService, BrowserAutomationError } from "../src/main/capabilities/BrowserAutomationService";

const profiles = join(process.cwd(), "out/tests/browser-electron-profiles");
mkdirSync(profiles, { recursive: true });
const root = mkdtempSync(join(profiles, "isolated-"));
app.setPath("userData", join(root, "profile"));
app.on("window-all-closed", () => {});
const output = join(process.cwd(), "out/diagnostics/builtin-browser");
mkdirSync(output, { recursive: true });
const report: { checks: unknown[]; error?: string; electron: string | undefined } = { checks: [], electron: process.versions.electron };
const external: string[] = [];
const originalExternal = shell.openExternal;
shell.openExternal = async (url: string) => { external.push(url); };
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url === "/next" ? "<title>Destination</title><h1>内置浏览器目标 7284</h1>" : `<title>Fixture</title><table><tr><td>Alpha</td><td>17</td><td>3</td></tr></table><a id="next" href="/next" target="_blank">Next</a><button id="popup" onclick="window.open('/next','_blank')">Popup</button><input id="name"><input id="password" type="password" value="SECRET-FIXTURE"><input id="hidden" type="hidden" value="HIDDEN-FIXTURE"><label>Notes<textarea>PRIVATE-TEXTAREA</textarea></label><div contenteditable="true" aria-label="editable notes">PRIVATE-EDITABLE</div><button id="save" onclick="document.body.dataset.saved=document.querySelector('#name').value">Save</button>`);
});
let win: BrowserWindow | undefined, host: BrowserHost | undefined;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(30); }
  throw new Error(`Timed out: ${label}; external opens=${external.length}`);
}
const guard = setTimeout(() => app.exit(1), 30_000);
void (async () => {
  await app.whenReady();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,Isolated browser regression");
  host = new BrowserHost(); host.attach(win);
  const service = new BrowserAutomationService(() => host!);
  const wc = host.inspectionWebContents!;
  const sourceTabId = host.activeTabId!;
  for (const selector of ["#next", "#popup"]) {
    host.selectTab(sourceTabId);
    await service.execute({ action: "navigate", url });
    await service.execute({ action: "read" });
    const previous = new Set(host.listTabs().map(tab => tab.id));
    await service.execute({ action: "click", selector });
    await until(() => host!.listTabs().some(tab => !previous.has(tab.id) && tab.openerTabId === sourceTabId
      && tab.url === url + "next" && !tab.loading), selector);
    const popup = host.listTabs().find(tab => !previous.has(tab.id) && tab.openerTabId === sourceTabId)!;
    assert.equal(wc.getURL(), url, "popup preserves the parent document");
    const child = host.getTabHost(popup.id)!.inspectionWebContents!;
    assert.notEqual(child.id, wc.id, "popup owns a distinct native WebContents");
    assert.equal(child.session, wc.session, "popup keeps the exact authenticated session");
    host.selectTab(popup.id);
    assert.match((await service.execute({ action: "read" })).text ?? "", /7284/);
    assert.equal(external.length, 0, "no external browser launch");
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    report.checks.push({ selector, url: child.getURL(), parentPreserved: true, managedPopup: true, externalOpens: external.length });
  }
  host.selectTab(sourceTabId);
  await service.execute({ action: "navigate", url });
  const observed = await service.execute({ action: "read" });
  assert.match(observed.text ?? "", /Alpha\t17\t3/, "rendered table cells retain their numeric boundaries");
  assert(observed.elements?.some(element => element.selector === "#name" && element.type === "text"));
  assert(observed.elements?.some(element => element.selector === "#save" && element.label === "Save"));
  assert(!observed.elements?.some(element => element.selector === "#hidden"));
  assert(!/SECRET-FIXTURE|HIDDEN-FIXTURE|PRIVATE-TEXTAREA|PRIVATE-EDITABLE/.test(JSON.stringify(observed.elements)), "target metadata contains labels, not editable values");
  for (const element of observed.elements ?? []) assert.equal(await wc.executeJavaScript(`document.querySelectorAll(${JSON.stringify(element.selector)}).length`), 1, "observed selector uniquely identifies its target");
  await service.execute({ action: "fill", selector: "#name", text: "verified" });
  // Actions intentionally change the observation; fresh reading remains the
  // explicit safety contract, not an automatic replay of a stale input.
  await service.execute({ action: "read" });
  await service.execute({ action: "click", selector: "#save" });
  assert.equal(await wc.executeJavaScript("document.body.dataset.saved"), "verified");
  report.checks.push({ name: "fresh-observation-form", saved: true });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await assert.rejects(service.execute({ action: "navigate", url: `http://127.0.0.1:${port}/?v=2` }),
    (e: unknown) => e instanceof BrowserAutomationError && e.message.includes("ERR_CONNECTION_REFUSED") && e.message.includes("gadget_open"));
  report.checks.push({ name: "real-refused-localhost", actionableError: true });
  console.log("builtin browser Electron: PASS (target=_blank, window.open, retained parent and managed popup/session, fresh form input, actual refused localhost)");
})().catch(error => { report.error = String(error?.stack ?? error); console.error(report.error); process.exitCode = 1; }).finally(() => {
  writeFileSync(join(output, "electron-results.json"), JSON.stringify(report, null, 2));
  shell.openExternal = originalExternal; host?.dispose(); if (win && !win.isDestroyed()) win.destroy(); server.close(); clearTimeout(guard); app.exit(Number(process.exitCode ?? 0));
});
