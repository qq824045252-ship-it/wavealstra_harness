import assert from "node:assert/strict";
import { app, BrowserWindow, screen } from "electron";
import { mkdtempSync } from "node:fs";
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
  let stoppedTask: string | undefined;
  let restoreHitTest: (() => void) | undefined;
  overlay.setAbortHandler((taskId) => { stoppedTask = taskId; coordinator.cancel(taskId); });
  try {
    overlay.present({ taskId: "overlay-smoke", target, phase: "acting", action: "click_client", cursor: { x: 200, y: 150, clicking: true } });
    await waitUntil(() => BrowserWindow.getAllWindows().some((win) => win.getTitle() === "__MYBUDDY_COMPUTER_USE_OVERLAY__"));
    const border = BrowserWindow.getAllWindows().find((win) => win.getTitle() === "__MYBUDDY_COMPUTER_USE_OVERLAY__");
    const controls = BrowserWindow.getAllWindows().find((win) => win.getTitle() === "__MYBUDDY_COMPUTER_USE_CONTROLS__");
    assert.ok(border && controls, "border and controls overlays must both exist");
    assert.equal(border!.isFocusable(), false, "visual border must never steal focus");
    assert.equal(controls!.isFocusable(), false, "controls bar must not steal target focus");
    await waitUntil(() => border!.isVisible() && controls!.isVisible());
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
    await host.shutdown().catch(() => undefined);
    app.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
