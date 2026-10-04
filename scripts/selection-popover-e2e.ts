// Bundle with esbuild --bundle --platform=node --format=cjs --external:electron.
import { app, BrowserWindow } from "electron";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { SelectionStore } from "../src/main/artifact/SelectionStore";
import { SelectionPopover } from "../src/main/artifact/SelectionPopover";

const root = mkdtempSync(join(tmpdir(), "mybuddy-popover-"));
app.setPath("userData", join(root, "profile"));
const timeout = setTimeout(() => { console.error("Timed out"); app.exit(1); }, 30000);
async function until(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!test()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise(r => setTimeout(r, 25)); }
}
void (async () => {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1000, height: 720, show: false, title: "MyBuddy 评论交互验证" });
  await win.loadURL('data:text/html,<body style="font:16px system-ui;background:%23f5f5f7;padding:30px">MyBuddy<br><br>评论验证<br><small>位置与备注一起加入聊天</small>');
  const host = new BrowserHost(); host.attach(win);
  const store = new SelectionStore();
  const popover = new SelectionPopover(() => store.getState());
  store.onChange(state => popover.invalidate(state));
  host.onSurfaceChanged = () => store.markStale("surface-generation-changed");
  const attached: Array<{ id?: number; comment?: string }> = [];
  let opened: Promise<void> | undefined;
  host.onSelection = selection => {
    store.setSelection(selection);
    opened = popover.show({ ...host.captureSurface!, selection,
      resume: () => { void host.resumeCapture(); },
      attach: comment => attached.push({ id: selection.backendNodeId, comment }),
    });
  };
  const file = join(root, "index.html");
  writeFileSync(file, '<body style="margin:0;background:#faf9f6;font:20px system-ui"><div style="height:800px"></div><div id="target" style="margin:20px;padding:28px;background:white;border:1px solid #ddd;border-radius:16px">含水率（标定）曲线图<br><small>请给这个位置添加备注</small></div><div style="height:600px"></div>');
  const wc = host.inspectionWebContents!;
  const loaded = new Promise<void>(resolve => wc.once("did-finish-load", () => resolve()));
  host.open(pathToFileURL(file).href); await loaded;
  host.setBounds({ x: 260, y: 50, width: 680, height: 580 });
  win.show();
  await wc.executeJavaScript('scrollTo(0,480)');
  const choose = async (): Promise<BrowserWindow> => {
    opened = undefined;
    await host.enterCapture();
    await host.resumeCapture();
    const rect = await wc.executeJavaScript('(()=>{const r=document.querySelector("#target").getBoundingClientRect();return {x:r.x+12,y:r.y+12}})()');
    wc.sendInputEvent({ type: "mouseMove", ...rect });
    wc.sendInputEvent({ type: "mouseDown", ...rect, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", ...rect, button: "left", clickCount: 1 });
    await until(() => !!opened); await opened;
    const popup = BrowserWindow.getAllWindows().find(item => item.getTitle() === "MyBuddy 元素评论");
    assert.ok(popup?.isVisible(), "真实鼠标抓取后出现原生评论菜单");
    return popup!;
  };
  let popup = await choose();
  const content = win.getContentBounds();
  const anchor = store.getState().descriptor!.bounds;
  const bounds = popup.getBounds();
  assert.ok(Math.abs(bounds.y - (content.y + 50 + anchor.y + anchor.height + 8)) < 3 || bounds.y < content.y + 50 + anchor.y, "浮层紧邻页面中选中的元素");
  console.log("PASS 真实网页滚动后抓取 → 就地浮层");
  popup.webContents.on("console-message", (event) => console.log("popup:", event.message));
  await popup.webContents.executeJavaScript('document.querySelector("#comment").click()', true);
  console.log("editor state", await popup.webContents.executeJavaScript('({hidden:editor.hidden,focus:document.activeElement.id,url:location.href.slice(0,40)})'));
  await until(() => popup.getBounds().height >= 208);
  assert.equal(await popup.webContents.executeJavaScript('document.activeElement.id'), 'text');
  console.log("PASS Ctrl+J 展开并聚焦评论输入框");
  await popup.webContents.executeJavaScript('text.value="把曲线图标题改为蓝色";text.dispatchEvent(new Event("input"))');
  mkdirSync("out/tests", { recursive: true });
  writeFileSync("out/tests/selection-popover-editor.png", (await popup.webContents.capturePage()).toPNG());
  popup.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["control"] });
  await until(() => attached.length === 1);
  assert.equal(attached[0].comment, "把曲线图标题改为蓝色");
  assert.ok(attached[0].id);
  await until(() => popup.isDestroyed());
  console.log("PASS 备注与可信位置一起回传，关闭菜单后可继续抓取");
  popup = await choose();
  popup.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  await until(() => attached.length === 2);
  assert.equal(attached[1].comment, undefined);
  console.log("PASS Enter 直接添加位置");
  popup = await choose();
  host.hardReload();
  assert.ok(popup.isDestroyed());
  assert.equal(store.getState().status, "stale");
  assert.equal(attached.length, 2);
  console.log("PASS 刷新页面立即关闭浮层，失效备注不会发送");
  popover.close(false); host.dispose(); win.destroy();
  clearTimeout(timeout); app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
