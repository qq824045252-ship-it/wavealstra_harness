import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { RuntimeProbeService } from "../src/main/capabilities/RuntimeProbeService";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("runtime probe electron smoke: watchdog timeout");
    process.exit(2);
  }, 10_000);
  watchdog.unref();

  await app.whenReady();
  const service = new RuntimeProbeService();
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  try {
    service.attach("app", win.webContents);
    const html = '<!doctype html><html><body><button id="probe">Probe</button></body></html>';
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await sleep(80);

    const mark = await service.execute({ action: "mark", target: "app" });
    const marker = mark.marker ?? 0;
    await win.webContents.executeJavaScript(`(() => {
      console.warn('runtime-probe-warning');
      setTimeout(() => Promise.reject(new Error('runtime-probe-rejection')), 20);
      setTimeout(() => { throw new Error('runtime-probe-throw'); }, 45);
    })()`, true);
    await sleep(250);

    const result = await service.execute({
      action: "read",
      target: "app",
      afterSequence: marker,
      limit: 100,
    });
    const events = result.events ?? [];
    assert(events.some((event) => event.kind === "console" && event.message.includes("runtime-probe-warning")), "console warning not captured");
    assert(events.some((event) => event.kind === "runtime-error" && event.message.includes("runtime-probe-rejection")), "unhandled rejection not captured");
    assert(events.some((event) => event.kind === "runtime-error" && event.message.includes("runtime-probe-throw")), "window error not captured");
    assert.equal(result.state?.available, true);
    assert.equal(result.state?.documentReadyState, "complete");
    assert.equal(result.state?.url?.startsWith("data:text/html"), true);
    console.log("runtime probe electron smoke: ok");
    clearTimeout(watchdog);
  } finally {
    service.detach("app", win.webContents);
    if (!win.isDestroyed()) win.destroy();
  }
}

void main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
