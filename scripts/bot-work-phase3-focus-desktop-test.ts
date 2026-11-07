import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
import { WindowsComputerUseBackend } from "../src/main/platform/computer-use/windows/WindowsComputerUseBackend";
import { computerUseRunCoordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";

const profile = mkdtempSync(join(tmpdir(), "work-phase3-focus-desktop-"));
app.setPath("userData", profile); process.env.HOME = profile; process.env.USERPROFILE = profile;
const evidence = join(process.cwd(), "out/diagnostics/bot-work-phase3/focus-desktop"); mkdirSync(evidence, { recursive: true });
const result: string[] = [];
const host = new BrowserHost(() => true), desktop = new WindowsComputerUseBackend();
const server = createServer((_request, response) => response.end("<!doctype html><title>Phase3 browser target</title><button id=effect onclick='window.effects=(window.effects||0)+1'>effect</button><input id=field><output id=status>initial</output>"));
const guard = setTimeout(() => { console.error("Phase3 real desktop timeout"); app.exit(1); }, 60_000);
let windowA: BrowserWindow | undefined, windowB: BrowserWindow | undefined;
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function main() {
  await app.whenReady();
  windowA = new BrowserWindow({ show: true, width: 700, height: 500, title: "Phase3 target A" });
  windowB = new BrowserWindow({ show: false, width: 500, height: 350, title: "Phase3 target B" });
  await windowA.loadURL("data:text/html,<title>Phase3 target A</title><button onclick='window.effects=(window.effects||0)+1'>own target</button>");
  await windowB.loadURL("data:text/html,<title>Phase3 target B</title><p>isolated alternate target</p>");
  let desktopFailure: unknown;
  try {
  windowA.setAlwaysOnTop(true, "screen-saver"); windowA.moveTop(); windowA.show(); app.focus({ steal: true }); windowA.focus(); await delay(300);
  await desktop.execute({ action: "focus_window", windowTitle: "Phase3 target A", taskId: "phase3-desktop-a" });
  const observed = await desktop.execute({ action: "inspect_window", windowTitle: "Phase3 target A", taskId: "phase3-desktop-a" });
  assert(observed.observationId && observed.window?.foreground, "requires a real active desktop session");
  await assert.rejects(desktop.execute({ action: "click_client", observationId: observed.observationId, x: 30, y: 30, taskId: "phase3-desktop-b" }), error => error instanceof Error && "code" in error && error.code === "STALE_OBSERVATION");
  result.push("real Windows HWND/PID observation cannot be borrowed by another task");
  windowB.show(); windowB.focus(); await desktop.execute({ action: "focus_window", windowTitle: "Phase3 target B", taskId: "phase3-desktop-b" }); await delay(120);
  await assert.rejects(desktop.execute({ action: "click_client", observationId: observed.observationId, x: 30, y: 30, taskId: "phase3-desktop-a" }), error => error instanceof Error && "code" in error && error.code === "FOCUS_FAILED");
  assert.equal(await windowA.webContents.executeJavaScript("window.effects||0"), 0);
  result.push("actual foreground switch rejects stale input before an effect");
  await desktop.waitForIdle(); result.push("actual Windows backend queue and host requests drained");
  } catch (error) {
    desktopFailure = error;
    console.error("REAL WINDOWS DESKTOP BLOCKED", error);
    try { console.log("CURRENT DESKTOP", JSON.stringify(await desktop.execute({ action: "active_window" }))); } catch { /* Failure remains blocked. */ }
  }

  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address !== "string");
  host.attach(windowA); host.setBounds({ x: 0, y: 0, width: 640, height: 420 });
  const browser = new BrowserAutomationService(() => host);
  await browser.execute({ action: "navigate", url: `http://127.0.0.1:${address.port}/first` });
  const wc = host.inspectionWebContents; assert(wc);
  await browser.execute({ action: "read" });
  await wc.executeJavaScript("document.querySelector('#status').textContent='external update'");
  await assert.rejects(browser.execute({ action: "click", selector: "#effect" }), error => error instanceof Error && "code" in error && error.code === "SURFACE_CHANGED");
  assert.equal(await wc.executeJavaScript("window.effects||0"), 0);
  await browser.execute({ action: "read" }); await browser.execute({ action: "click", selector: "#effect" });
  assert.equal(await wc.executeJavaScript("window.effects"), 1);
  result.push("real BrowserHost DOM update invalidates observed action; reread permits exactly one effect");
  await browser.execute({ action: "read" }); await wc.executeJavaScript("document.querySelector('#field').focus()");
  await assert.rejects(browser.execute({ action: "click", selector: "#effect" }), error => error instanceof Error && "code" in error && error.code === "SURFACE_CHANGED");
  await browser.execute({ action: "read" });
  await wc.loadURL(`http://127.0.0.1:${address.port}/second`);
  await assert.rejects(browser.execute({ action: "click", selector: "#effect" }), error => error instanceof Error && "code" in error && error.code === "SURFACE_CHANGED");
  result.push("actual DOM focus and navigation changes reject old browser observation");
  let screenshotError: string | undefined;
  try { const screenshot = await windowA.webContents.capturePage(); writeFileSync(join(evidence, "targets.png"), screenshot.toPNG()); }
  catch (error) { screenshotError = String(error); console.error("CAPTURE LIMITATION", error); }
  writeFileSync(join(evidence, "report.json"), JSON.stringify({ platform: "Windows", desktop: "real Electron target + native Windows backend", result: desktopFailure ? "blocked" : "passed", desktopError: desktopFailure ? String(desktopFailure) : undefined, screenshotError, checks: result }, null, 2));
  console.log(JSON.stringify({ result: desktopFailure ? "blocked" : "passed", checks: result }));
  if (desktopFailure) throw desktopFailure;
}
void main().then(async () => {
  clearTimeout(guard); host.dispose(); windowA?.destroy(); windowB?.destroy();
  computerUseRunCoordinator.endTask("phase3-desktop-a"); computerUseRunCoordinator.endTask("phase3-desktop-b");
  await desktop.shutdown(); server.close(); app.exit(0);
}).catch(async error => {
  console.error(error); if (!existsSync(join(evidence, "report.json"))) writeFileSync(join(evidence, "report.json"), JSON.stringify({ result: "failed", checks: result, error: String(error) }, null, 2));
  clearTimeout(guard); await desktop.shutdown(); server.close(); app.exit(1);
});
