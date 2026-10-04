// TrayService 行为冒烟测试（驱动真实 TrayService 代码）
// 1) 初始化后 shouldSuppressQuit() 应为 true（托盘存活）
// 2) 关闭事件 → 窗口隐藏且 preventDefault 被调用（应用不退出）
// 3) setCloseToTray(false) 后 → 关闭事件不再拦截
// 4) dispose() → shouldSuppressQuit() 变 false
// 运行：electron scripts/tray-service-test.cjs
const { app, BrowserWindow } = require("electron");
const { TrayService } = require("../out/tests/tray-service-test.cjs");

function makeCloseEvent() {
  let prevented = false;
  return {
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

const results = [];
function assert(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 640, height: 480, show: false });
  let beforeReload = 0;
  const svc = new TrayService();
  svc.initialize(win, {
    onBeforeReload: () => {
      beforeReload += 1;
    },
  });

  // 1) 托盘已创建
  assert("托盘已创建并存活", svc.shouldSuppressQuit() === true);

  // 2) 关闭事件 → 拦截 + 窗口隐藏
  const evt = makeCloseEvent();
  win.emit("close", evt);
  assert("关闭事件被拦截 (preventDefault)", evt.defaultPrevented === true);
  assert("窗口已隐藏", win.isVisible() === false);
  assert("应用仍存活 (未退出)", app.isReady() === true);

  // 3) 关闭到托盘关闭后 → 不再拦截，且 window-all-closed 不再抑制退出
  svc.setCloseToTray(false);
  const evt2 = makeCloseEvent();
  win.emit("close", evt2);
  assert("关闭开关关闭后不拦截", evt2.defaultPrevented === false);
  assert("关闭开关关闭后不抑制退出", svc.shouldSuppressQuit() === false);

  // 4) 托盘刷新：先露出窗口，再 reload 渲染进程
  const wc = win.webContents;
  let reloaded = false;
  const origReload = wc.reload.bind(wc);
  wc.reload = () => {
    reloaded = true;
  };
  svc.reloadMainWindow();
  assert("刷新会调用 onBeforeReload", beforeReload === 1);
  assert("刷新会 reload 渲染进程", reloaded === true);
  wc.reload = origReload;

  // 5) dispose 后托盘销毁
  svc.setCloseToTray(true);
  svc.dispose();
  assert("dispose 后托盘不再存活", svc.shouldSuppressQuit() === false);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
  win.destroy();
  app.quit();
  process.exitCode = failed.length > 0 ? 1 : 0;
});
