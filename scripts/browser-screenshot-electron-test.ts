import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
import { UiAutomationService } from "../src/main/capabilities/UiAutomationService";
import { pageInspectionService } from "../src/main/artifact/PageInspectionService";

const profile = mkdtempSync(join(tmpdir(), "mybuddy-browser-screenshot-"));
app.setPath("userData", join(profile, "profile"));
const evidence = join(process.cwd(), "artifacts/computer-use-browser-repair/production-capture");
mkdirSync(evidence, { recursive: true });
const results: unknown[] = [];
const html = `<!doctype html><meta charset="utf-8"><title>Screenshot fixture</title>
<style>html,body{margin:0;width:100%;height:100%}body{background:linear-gradient(135deg,#ef3628,#294ac9 45%,#21c774);color:white;font:36px sans-serif}button{margin:32px;padding:20px;font-size:30px;background:#ffee18}#color{width:300px;height:180px;background:#9326ed}</style>
<button id="increment" onclick="document.querySelector('#count').textContent=++window.count;document.querySelector('#color').style.background=window.count%2?'#f1206c':'#9326ed'">Click</button><span id="count">0</span><div id="color"></div><script>window.count=0</script>`;
const server = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(html); });
const guard = setTimeout(() => { console.error("browser screenshot test timed out"); app.exit(1); }, 90_000);
app.on("window-all-closed", () => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function checkedImage(bytes: Uint8Array) {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  assert(!image.isEmpty());
  const { width, height } = image.getSize();
  assert(width >= 640 && height >= 480);
  const pixels = image.toBitmap();
  let colored = 0;
  let samples = 0;
  for (let offset = 0; offset + 3 < pixels.length; offset += 4 * 17) {
    const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
    if (Math.max(...channels) - Math.min(...channels) > 35) colored++;
    samples++;
  }
  assert(colored / samples > 0.75, "nonempty white/blank screenshots must fail");
  return { width, height, coloredRatio: colored / samples, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function fixture(url: string) {
  const win = new BrowserWindow({ show: false, width: 800, height: 640 });
  await win.loadURL("data:text/html,<body>Isolated screenshot regression parent</body>");
  const host = new BrowserHost(() => true);
  host.attach(win);
  const view = host.captureSurface!.view;
  // Test the fresh hidden view's production default viewport before navigation.
  assert(view.getBounds().width > 0 && view.getBounds().height > 0);
  assert.equal(host.visible, false);
  host.setBounds({ x: 0, y: 0, width: 640, height: 480 });
  host.hide();
  const service = new BrowserAutomationService(() => host);
  await service.execute({ action: "navigate", url });
  const wc = host.inspectionWebContents!;
  const ui = new UiAutomationService({ app: () => null, browser: () => null, artifact: () => null });
  ui.setBrowserHost(host);
  return { win, host, view, service, wc, ui,
    close: () => { host.dispose(); if (!wc.isDestroyed()) wc.close(); if (!win.isDestroyed()) win.destroy(); },
  };
}

async function queueSettled(host: BrowserHost) {
  await (host as unknown as { screenshotQueue: Promise<void> }).screenshotQueue;
}

void (async () => {
  await app.whenReady();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const preflight = await fixture(url);
  try {
    const originalUrl = preflight.wc.getURL();
    const originalFocus = await preflight.wc.executeJavaScript("document.activeElement.tagName");
    await assert.rejects(preflight.service.execute({ action: "navigate", url: "file:///tmp/blocked.html" }), /只允许 http/);
    await assert.rejects(preflight.service.execute({ action: "press", key: "PageDown" }), /selector 不能为空/);
    assert.equal(preflight.wc.getURL(), originalUrl);
    assert.equal(await preflight.wc.executeJavaScript("document.activeElement.tagName"), originalFocus);
    await preflight.service.execute({ action: "click", selector: "#increment" });
    assert.equal(await preflight.wc.executeJavaScript("document.querySelector('#count').textContent"), "1");
    results.push({ mode: "invalid-input-then-independent-action", invalidUrl: "not_started", missingSelector: "not_started", continued: true });
  } finally { preflight.close(); }
  for (const mode of ["hidden", "inspector", "blocker", "minimized", "visible"] as const) {
    const f = await fixture(url);
    try {
      if (mode === "blocker") { f.host.addBlocker("test-modal"); f.host.setBounds({ x: 0, y: 0, width: 640, height: 480 }); }
      if (mode === "inspector") await f.host.enterCapture();
      if (mode === "visible") { f.host.show(); f.win.showInactive(); }
      if (mode === "minimized") {
        const minimized = new Promise<void>((resolve) => f.win.once("minimize", () => resolve()));
        f.win.showInactive(); f.win.minimize(); await minimized;
      }
      const bounds = f.view.getBounds();
      const visibility = [f.win.isVisible(), f.win.isMinimized(), f.host.visible];
      const inspector = pageInspectionService.sessionFor(f.wc, "browser-host");
      let lastHash = "";
      for (let index = 0; index < 10; index++) {
        if (index) await f.service.execute({ action: "click", selector: "#increment" });
        const started = Date.now();
        const bytes = index === 1
          ? (await f.ui.execute({ action: "screenshot", target: "browser" })).screenshot!
          : (await f.service.execute({ action: "screenshot" })).screenshot!;
        const image = checkedImage(bytes);
        if (index) assert.notEqual(image.sha256, lastHash, "screenshot must reflect the intervening real DOM click");
        lastHash = image.sha256;
        assert.deepEqual(f.view.getBounds(), bounds);
        assert.deepEqual([f.win.isVisible(), f.win.isMinimized(), f.host.visible], visibility);
        assert.equal(f.view.getVisible(), f.host.visible, "temporary presenting view must return to product visibility");
        assert.deepEqual(BrowserWindow.getAllWindows(), [f.win], "capture must release its temporary window");
        assert.deepEqual(await f.wc.executeJavaScript("[innerWidth,innerHeight,window.count]"), [640, 480, index]);
        if (inspector) { assert.equal(pageInspectionService.sessionFor(f.wc, "browser-host"), inspector); assert(inspector.isAttached && inspector.inspectMode); }
        else assert.equal(pageInspectionService.sessionFor(f.wc, "browser-host"), null, "capture must release its temporary debugger owner");
        writeFileSync(join(evidence, `${mode}-${index}.png`), bytes);
        results.push({ mode, index, elapsedMs: Date.now() - started, ...image });
      }
      console.log(`PASS continuous screenshots: ${mode}`);
    } finally { f.close(); }
  }

  // The user can hide/minimize the window or open a blocking modal after a
  // visible capture starts. The exact page must continue presenting until done.
  for (const transition of ["window-hide", "window-minimize", "panel-blocker"] as const) {
    const f = await fixture(url);
    try {
      f.host.show(); f.win.showInactive();
      const original = f.wc.debugger.sendCommand.bind(f.wc.debugger);
      let armed = true;
      f.wc.debugger.sendCommand = async (method, params) => {
        if (armed && method === "Page.captureScreenshot") {
          armed = false;
          if (transition === "window-hide") f.win.hide();
          else if (transition === "window-minimize") f.win.minimize();
          else f.host.addBlocker("during-capture");
        }
        return original(method, params);
      };
      checkedImage(await f.host.captureScreenshot({ timeoutMs: 3000 }));
      f.wc.debugger.sendCommand = original;
      checkedImage(await f.host.captureScreenshot({ timeoutMs: 3000 }));
      assert.deepEqual(BrowserWindow.getAllWindows(), [f.win]);
      assert.equal(f.view.getVisible(), f.host.visible);
      assert.deepEqual(await f.wc.executeJavaScript("[innerWidth,innerHeight]"), [640, 480]);
      results.push({ mode: `capture-during-${transition}`, currentFrame: true, subsequentCaptureRecovered: true });
    } finally { f.close(); }
  }

  // Cancel while the real native snapshot is pending, not after its ACK.
  // The caller returns promptly while the host preserves/drains the producer.
  for (const existingInspector of [false, true]) {
    const f = await fixture(url);
    try {
      if (existingInspector) await f.host.enterCapture();
      const controller = new AbortController();
      const original = f.wc.debugger.sendCommand.bind(f.wc.debugger);
      f.wc.debugger.sendCommand = async (method, params) => {
        const native = original(method, params);
        if (method === "Page.captureScreenshot") controller.abort();
        return native;
      };
      const started = Date.now();
      await assert.rejects(f.host.captureScreenshot({ signal: controller.signal }), (error: unknown) => error instanceof Error && error.name === "AbortError");
      assert(Date.now() - started < 500, "caller must not wait for the cancelled native snapshot");
      await queueSettled(f.host);
      f.wc.debugger.sendCommand = original;
      assert.deepEqual(BrowserWindow.getAllWindows(), [f.win]);
      assert.equal(f.view.getVisible(), false);
      checkedImage(await f.host.captureScreenshot({ timeoutMs: 3000 }));
      results.push({ mode: "cancel-in-flight-native-capture", existingInspector, callerPrompt: true, recovered: true });
    } finally { f.close(); }
  }

  // Abort after the real native screenshot acknowledges; late completion must
  // preserve both the DOM viewport and the existing inspector owner.
  for (const existingInspector of [false, true]) {
    const f = await fixture(url);
    try {
      if (existingInspector) await f.host.enterCapture();
      const controller = new AbortController();
      const original = f.wc.debugger.sendCommand.bind(f.wc.debugger);
      let armed = true;
      let emulationCommands = 0;
      f.wc.debugger.sendCommand = async (method, params) => {
        if (method.startsWith("Emulation.")) emulationCommands++;
        const value = await original(method, params);
        if (armed && method === "Page.captureScreenshot") { armed = false; controller.abort(); }
        return value;
      };
      await assert.rejects(f.host.captureScreenshot({ signal: controller.signal }), (error: unknown) => error instanceof Error && error.name === "AbortError");
      await queueSettled(f.host);
      f.wc.debugger.sendCommand = original;
      const viewport = await f.wc.executeJavaScript("[innerWidth,innerHeight]");
      results.push({ mode: "abort-after-native-capture", existingInspector, viewport, emulationCommands });
      assert.deepEqual(viewport, [640, 480], "cancellation must restore the actual DOM viewport");
      assert.equal(emulationCommands, 0, "capture must not override the viewport");
      assert.deepEqual(BrowserWindow.getAllWindows(), [f.win]);
      assert.equal(f.view.getVisible(), false);
      checkedImage(await f.host.captureScreenshot());
    } finally { f.close(); }
  }

  const f = await fixture(url);
  try {
    await f.host.enterCapture();
    const inspector = pageInspectionService.sessionFor(f.wc, "browser-host")!;
    const original = f.wc.debugger.sendCommand.bind(f.wc.debugger);
    const entered = deferred<void>();
    const release = deferred<void>();
    let commands = 0;
    let hold = true;
    f.wc.debugger.sendCommand = async (method, params) => {
      commands++;
      const value = await original(method, params);
      if (hold && method === "Page.captureScreenshot") { entered.resolve(); await release.promise; }
      return value;
    };
    const first = f.host.captureScreenshot({ timeoutMs: 500 });
    // Install the rejection handler before awaiting the injected native hold.
    const rejectedFirst = assert.rejects(first, (error: any) => error.code === "CAPTURE_TIMEOUT");
    await entered.promise;
    await rejectedFirst;
    const before = commands;
    const controller = new AbortController();
    const queued = f.host.captureScreenshot({ signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await assert.rejects(f.host.captureScreenshot({ timeoutMs: 80 }), (error: any) => error.code === "CAPTURE_TIMEOUT");
    assert.equal(commands, before, "timed out native work must not overlap a later capture");
    assert.equal(pageInspectionService.sessionFor(f.wc, "browser-host"), inspector);
    assert(inspector.isAttached && inspector.inspectMode);
    hold = false; release.resolve(); await queueSettled(f.host);
    f.wc.debugger.sendCommand = original;
    checkedImage(await f.host.captureScreenshot());
    results.push({ mode: "late-native-result", cancelledQueue: true, timeoutQueue: true, preservedInspector: true, recovered: true });

    for (const change of ["layout", "navigation"] as const) {
      const captured = deferred<void>();
      const finish = deferred<void>();
      f.wc.debugger.sendCommand = async (method, params) => {
        const value = await original(method, params);
        if (method === "Page.captureScreenshot") { captured.resolve(); await finish.promise; }
        return value;
      };
      const pending = f.host.captureScreenshot();
      const rejected = assert.rejects(pending, (error: any) => error.code === "SURFACE_CHANGED");
      await captured.promise;
      if (change === "layout") { f.host.setBounds({ x: 0, y: 0, width: 672, height: 504 }); f.host.hide(); }
      else await f.service.execute({ action: "navigate", url: `${url}?changed=1` });
      finish.resolve(); await rejected; await queueSettled(f.host);
      f.wc.debugger.sendCommand = original;
      assert.deepEqual(f.view.getBounds(), { x: 0, y: 0, width: 672, height: 504 });
      checkedImage(await f.host.captureScreenshot());
      results.push({ mode: `stale-${change}`, rejected: true, currentBoundsPreserved: true });
    }
  } finally { f.close(); }
  writeFileSync(join(evidence, "results.json"), JSON.stringify({ at: new Date().toISOString(), electron: process.versions.electron, profile, results }, null, 2));
  console.log(`browser screenshot Electron: PASS (${results.length} checks), ${join(evidence, "results.json")}`);
})().then(() => { clearTimeout(guard); server.close(); app.quit(); }, (error) => {
  console.error(error);
  writeFileSync(join(evidence, "results.json"), JSON.stringify({ error: String(error), results }, null, 2));
  clearTimeout(guard); server.close(); app.exit(1);
});
