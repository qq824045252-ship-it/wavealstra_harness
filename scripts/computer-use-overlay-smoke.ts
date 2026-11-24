import assert from "node:assert/strict";
import { app, BrowserWindow, desktopCapturer, screen } from "electron";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseOverlayService } from "../src/main/platform/computer-use/overlay";
import { ComputerUseRunCoordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";
import { WindowsAutomationHost } from "../src/main/platform/computer-use/windows/WindowsAutomationHost";
import type { WindowInfo } from "../src/main/platform/computer-use/protocol";

const profile = mkdtempSync(join(tmpdir(), "mybuddy-cu-overlay-"));
app.setPath("userData", profile); process.env.HOME = profile; process.env.USERPROFILE = profile;

const target: WindowInfo = {
  handle: "1",
  processId: process.pid,
  processName: "electron",
  title: "Overlay Smoke Target",
  className: "Smoke",
  visible: true,
  minimized: false,
  foreground: true,
  windowRect: { left: 120, top: 120, right: 820, bottom: 620, width: 700, height: 500 },
  clientRect: { x: 0, y: 0, width: 680, height: 460 },
  clientOrigin: { x: 130, y: 150 },
  dpi: 96,
  scaleFactor: 1,
};

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("timed out waiting for overlay state");
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("overlay smoke requires Windows");
  await app.whenReady();
  const overlay = new ComputerUseOverlayService();
  const coordinator = new ComputerUseRunCoordinator();
  const parent = new AbortController();
  const scoped = coordinator.scope("overlay-smoke", parent.signal);
  const host = new WindowsAutomationHost();
  const display = screen.getPrimaryDisplay();
  const sample = new BrowserWindow({ x: display.workArea.x + 64, y: display.workArea.y + 64, width: 560, height: 320,
    frame: false, show: false, focusable: false, alwaysOnTop: true, skipTaskbar: true });
  await sample.loadURL('data:text/html,' + encodeURIComponent('<style>body{margin:0;height:100vh;background:linear-gradient(to right,#184839 50%,#783342 50%);display:grid;place-content:center;color:white;font:24px Segoe UI}</style><div>Overlay transparency test</div>'));
  sample.showInactive();
  const area = sample.getContentBounds();
  const topLeft = screen.dipToScreenPoint(area);
  const bottomRight = screen.dipToScreenPoint({ x: area.x + area.width, y: area.y + area.height });
  target.windowRect = { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y, width: bottomRight.x-topLeft.x, height: bottomRight.y-topLeft.y };
  target.clientOrigin = topLeft;
  target.scaleFactor = display.scaleFactor;
  async function sampleDesktop() {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor),
    } });
    const sourceByDisplay = sources.find(item => item.display_id === String(display.id));
    // Some Windows capturers omit the display ID even when returning the sole screen.
    const onlyScreen = screen.getAllDisplays().length === 1 && sources.length === 1 && !sources[0].display_id;
    const source = sourceByDisplay ?? (onlyScreen ? sources[0] : undefined);
    assert(source && !source.thumbnail.isEmpty(), "capture the display containing the test window");
    const size = source.thumbnail.getSize();
    const sx = size.width / display.size.width, sy = size.height / display.size.height;
    return source.thumbnail.crop({ x: Math.round((area.x-display.bounds.x)*sx), y: Math.round((area.y-display.bounds.y)*sy),
      width: Math.round(area.width*sx), height: Math.round(area.height*sy) });
  }
  function rgb(image: Electron.NativeImage, fx: number, fy: number) {
    const {width, height} = image.getSize();
    const offset = 4*(Math.floor(height*fy)*width+Math.floor(width*fx));
    const bgra = image.toBitmap();
    return [bgra[offset+2], bgra[offset+1], bgra[offset]];
  }
  let stoppedTask: string | undefined;
  let restoreHitTest: (() => void) | undefined;
  overlay.setAbortHandler((taskId) => { stoppedTask = taskId; coordinator.cancel(taskId); });
  try {
    let baseline = await sampleDesktop();
    await waitUntil(async () => {
      baseline = await sampleDesktop();
      return rgb(baseline,.25,.75).join(",") === "24,72,57";
    });
    assert.deepEqual(rgb(baseline, .25, .75), [24,72,57], "test window must be visible before measuring");
    assert.deepEqual(rgb(baseline, .75, .75), [120,51,66]);
    overlay.present({ taskId: "overlay-smoke", target, phase: "acting", action: "click_client", cursor: { x: 200, y: 150, clicking: true } });
    await waitUntil(() => BrowserWindow.getAllWindows().some((win) => win.getTitle() === "__MYBUDDY_COMPUTER_USE_OVERLAY__"));
    const border = BrowserWindow.getAllWindows().find((win) => win.getTitle() === "__MYBUDDY_COMPUTER_USE_OVERLAY__");
    const controls = BrowserWindow.getAllWindows().find((win) => win.getTitle() === "__MYBUDDY_COMPUTER_USE_CONTROLS__");
    assert.ok(border && controls, "border and controls overlays must both exist");
    assert.equal(border!.isFocusable(), false, "visual border must never steal focus");
    assert.equal(controls!.isFocusable(), false, "controls bar must not steal target focus");
    await waitUntil(() => border!.isVisible() && controls!.isVisible());
    assert(border.isContentProtected(), "Agent captures normally exclude the overlay");
    // Include the border in this diagnostic capture so an invisible overlay cannot pass.
    border.setContentProtection(false);
    border.setBackgroundColor("#ffffff");
    await new Promise(resolve => setTimeout(resolve, 200));
    const painted = await sampleDesktop();
    assert.deepEqual(rgb(painted,.25,.75), rgb(baseline,.25,.75), "left program pixels must survive an opaque native backdrop");
    assert.deepEqual(rgb(painted,.75,.75), rgb(baseline,.75,.75), "right program pixels must survive an opaque native backdrop");
    const nearCursor = [216 / area.width, 166 / area.height] as const;
    assert.deepEqual(rgb(painted,...nearCursor), rgb(baseline,...nearCursor), "no white square around the pointer");
    const [r,g,b] = rgb(painted,.5,1.5/area.height);
    assert(b > r+75 && b > g+45, `blue border must be visible on desktop: ${r},${g},${b}`);
    mkdirSync("out/tests", { recursive: true });
    border.setBackgroundColor("#00000000");
    await new Promise(resolve => setTimeout(resolve, 120));
    writeFileSync("out/tests/computer-use-overlay-transparent.png", (await sampleDesktop()).toPNG());
    // Exercise the full-monitor overlay and reuse of its window after resize.
    overlay.presentDesktop({ taskId: "overlay-smoke", phase: "acting", action: "mouse_move",
      xPhysical: topLeft.x + Math.round(100 * display.scaleFactor), yPhysical: topLeft.y + Math.round(80 * display.scaleFactor) });
    // Fractional Windows DPI can round a native width by one DIP.
    await waitUntil(() => Math.abs(border.getBounds().width - display.bounds.width) <= 1);
    const desktopFrame = await sampleDesktop();
    assert.deepEqual(rgb(desktopFrame,.25,.75), rgb(baseline,.25,.75));
    assert.deepEqual(rgb(desktopFrame,200/area.width,150/area.height), rgb(baseline,200/area.width,150/area.height), "the old cursor position clears");
    overlay.present({ taskId: "overlay-smoke", target, phase: "acting", action: "click_client" });
    await waitUntil(() => Math.abs(border.getBounds().width - area.width) <= 1);
    border.setContentProtection(true);
    assert.equal(await controls!.webContents.executeJavaScript('document.querySelector("a").textContent'), "停止操作");
    const bounds = controls!.getBounds();
    const originalCursor = screen.getCursorScreenPoint;
    const originalIgnore = controls!.setIgnoreMouseEvents.bind(controls!);
    let syntheticPoint = { x: bounds.x + bounds.width - 30, y: bounds.y + 18 };
    let ignored: boolean | undefined;
    screen.getCursorScreenPoint = () => syntheticPoint;
    controls!.setIgnoreMouseEvents = (ignore, options) => { ignored = ignore; originalIgnore(ignore, options); };
    restoreHitTest = () => { screen.getCursorScreenPoint = originalCursor; controls!.setIgnoreMouseEvents = originalIgnore; };
    await waitUntil(() => ignored === false);
    assert.equal(await controls!.webContents.executeJavaScript('document.body.dataset.phase'), "acting", "Stop must be interactive while the actual overlay is acting");
    syntheticPoint = { x: bounds.x + 20, y: bounds.y + 18 };
    await waitUntil(() => ignored === true);
    restoreHitTest();
    restoreHitTest = undefined;
    overlay.hideAfterStep("overlay-smoke", 0);
    await waitUntil(() => !border!.isVisible() && !controls!.isVisible());
    assert.equal(scoped.aborted, false, "automatic retraction must not cancel later desktop work");
    overlay.present({ taskId: "overlay-smoke", target, phase: "acting", action: "click_client" });
    await waitUntil(() => border!.isVisible() && controls!.isVisible());

    const listed = await host.request<"list_windows", any[]>("list_windows", {});
    assert.equal(listed.some((item) => String(item.title).startsWith("__MYBUDDY_COMPUTER_USE_")), false, "automation host must hide overlay windows from Agent observation");

    await controls!.webContents.executeJavaScript('location.href="mybuddy-computer-use://stop"', true).catch(() => undefined);
    await waitUntil(() => stoppedTask === "overlay-smoke");
    assert.equal(stoppedTask, "overlay-smoke", "Stop control must reach the CU cancellation handler");
    assert.equal(scoped.aborted, true, "Stop must cancel the CU scope");
    assert.equal(parent.signal.aborted, false, "Stop must leave the parent Agent active");
    assert.throws(() => coordinator.scope("overlay-smoke"), /停止本轮 Computer Use/, "The current parent run must not reopen CU after Stop");
    await waitUntil(() => !border!.isVisible() && !controls!.isVisible());
    console.log("computer use overlay PASS (border/cursor window, Stop hittable while acting, other pill area click-through, automatic idle retraction and reopening, observation filtering, scoped Stop without Agent abort, stopped overlay hidden)");
  } finally {
    restoreHitTest?.();
    coordinator.endTask("overlay-smoke", "failed");
    overlay.dispose();
    sample.destroy();
    await host.shutdown().catch(() => undefined);
    app.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
