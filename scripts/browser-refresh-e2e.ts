import { app, BrowserWindow } from "electron";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserHost } from "../src/main/browser/BrowserHost";

const root = mkdtempSync(join(tmpdir(), "mybuddy-browser-refresh-"));
app.setPath("userData", join(root, "profile"));
let version = 1;
const html = () => `<link rel="stylesheet" href="style.css"><body>HTML-${version}<script src="app.js"></script></body>`;
const js = () => `document.body.dataset.version = '${version}'`;
const css = () => `body { color: rgb(${version}, 0, 0); }`;
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(js()); }
  else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css()); }
  else { res.setHeader("Content-Type", "text/html"); res.end(html()); }
});
const timeout = setTimeout(() => { console.error("Timed out"); app.exit(1); }, 30000);
void (async () => {
  await app.whenReady();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const win = new BrowserWindow({ show: false });
  let allowUnload = true;
  let unloadPrompts = 0;
  const host = new BrowserHost(() => { unloadPrompts++; return allowUnload; });
  host.attach(win);
  const wc = host.inspectionWebContents!;
  const load = (action: () => void) => new Promise<void>((resolve, reject) => {
    const finished = () => { wc.removeListener("did-fail-load", failed); resolve(); };
    const failed = (_event: Electron.Event, code: number, description: string) => {
      wc.removeListener("did-finish-load", finished); reject(new Error(`${code}: ${description}`));
    };
    wc.once("did-finish-load", finished);
    wc.once("did-fail-load", failed);
    action();
  });
  const check = async (label: string) => {
    const actual = await wc.executeJavaScript(`({html: document.body.textContent, js: document.body.dataset.version, css: getComputedStyle(document.body).color})`);
    console.log(label, JSON.stringify(actual));
    assert.ok(actual.html.includes(`HTML-${version}`), label + " HTML");
    assert.equal(actual.js, String(version), label + " JS");
    assert.equal(actual.css, `rgb(${version}, 0, 0)`, label + " CSS");
  };
  const address = server.address() as { port: number };
  await load(() => host.open(`http://127.0.0.1:${address.port}/`));
  await check("HTTP initial");
  version++;
  await load(() => host.reload());
  await check("HTTP refresh while hidden");
  version++;
  await load(() => host.hardReload());
  await check("HTTP hard refresh");
  const save = () => {
    writeFileSync(join(root, "index.html"), html());
    writeFileSync(join(root, "app.js"), js());
    writeFileSync(join(root, "style.css"), css());
  };
  save();
  const fileUrl = pathToFileURL(join(root, "index.html")).href;
  await load(() => host.open(fileUrl));
  await check("file initial");
  version++; save();
  await load(() => host.reload());
  await check("file refresh");
  version++; save();
  await load(() => host.hardReload());
  await check("file hard refresh");
  version++; save();
  await load(() => host.open(fileUrl));
  await check("file reopen");
  await wc.executeJavaScript(`window.addEventListener('beforeunload', e => {
    e.preventDefault(); e.returnValue = 'unsaved data';
  }); navigator.userActivation.hasBeenActive`, true);
  // 与真实任务一致：隐藏保留旧文档，重开时页面阻止离开。
  host.close();
  allowUnload = false;
  version++; save();
  await new Promise<void>((resolve) => {
    wc.once("did-stop-loading", () => resolve());
    host.open(fileUrl);
  });
  assert.equal(unloadPrompts, 1, "blocked reload offers a choice");
  assert.equal(host.url, fileUrl, "cancelled reopen retains the loaded document identity");
  assert.equal(await wc.executeJavaScript("document.body.dataset.version"), String(version - 1), "cancel keeps input/document");
  let captureState = "";
  host.onCaptureStateChanged = (state) => { captureState = state; };
  await host.enterCapture();
  assert.equal(captureState, "active", "capture still works after cancelled reopen");
  host.exitCapture();
  allowUnload = true;
  await load(() => host.hardReload());
  await check("beforeunload accepted: updated file");
  assert.equal(unloadPrompts, 2, "hard refresh honors unload confirmation");
  if (process.env.MYBUDDY_BROWSER_TEST_FILE) {
    const originalUrl = pathToFileURL(process.env.MYBUDDY_BROWSER_TEST_FILE).href;
    await load(() => host.open(originalUrl));
    // 只改隔离测试浏览器的表单状态，不改用户 HTML 或用户浏览器草稿。
    await wc.executeJavaScript(`(() => {
      const input = document.querySelector('#dataBody input.w');
      if (!input) throw new Error('task sample input missing');
      input.value = '1';
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`, true);
    const before = unloadPrompts;
    await load(() => host.hardReload());
    assert.equal(unloadPrompts, before + 1, "real task HTML requests unload confirmation");
    assert.equal(host.url, originalUrl);
    console.log("PASS real task HTML reload with its own beforeunload handler");
  }
  assert.ok(host.captureVersion >= 7, "refresh invalidates capture generation");
  wc.close();
  win.destroy();
  server.close();
  clearTimeout(timeout);
  console.log("PASS browser refresh Electron runtime");
  app.exit(0);
})().catch((error) => { console.error(error); app.exit(1); });
