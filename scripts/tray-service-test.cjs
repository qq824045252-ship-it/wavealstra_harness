// TrayService 行为冒烟测试（驱动真实 TrayService 代码）
// 1) 初始化后 shouldSuppressQuit() 应为 true（托盘存活）
// 2) 关闭事件 → 窗口隐藏且 preventDefault 被调用（应用不退出）
// 3) setCloseToTray(false) 后 → 关闭事件不再拦截
// 4) dispose() → shouldSuppressQuit() 变 false
// 5) Linux 用 png；托盘创建失败时 Linux 仍驻留，其它平台不拦截关闭
// 运行：electron scripts/tray-service-test.cjs
//
// 隔离：Electron 默认把 Chromium 状态/托盘相关缓存写到真实 userData
// （Linux ~/.config/<app>、Windows %APPDATA%\<app>）。这里在 ready 前改到临时目录，
// 避免门禁把测试 profile 写进开发者/CI 的真实用户目录。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { TrayService, trayIconAsset, resolveTrayPlatformBehavior } = require("../out/tests/tray-service-test.cjs");

// 固定路径 + 每次开头重建：Electron 的 native 退出路径在 quit 之后仍会写 Cache/
// declarative_performance_observer.db 等文件，进程内删除只能尽力而为；固定路径保证
// /tmp 里最多留一个 mybuddy-tray-test，且每次运行都是干净 profile（不会串状态）。
const sandboxUserData = path.join(os.tmpdir(), "mybuddy-tray-test");
try {
  fs.rmSync(sandboxUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  /* 上一轮残留可能被并发进程占用，尽力而为 */
}
fs.mkdirSync(sandboxUserData, { recursive: true });
app.setPath("userData", sandboxUserData);
app.setPath("sessionData", sandboxUserData);
function cleanupSandboxProfile() {
  try {
    fs.rmSync(sandboxUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort */
  }
}
app.on("quit", cleanupSandboxProfile);
process.on("exit", cleanupSandboxProfile);

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
  assert("托盘已创建并存活", svc.hasTray() === true && svc.shouldSuppressQuit() === true);

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

  assert(
    "linux 托盘图标是 png",
    trayIconAsset("linux").endsWith(`${path.sep}tray.png`) && fs.existsSync(trayIconAsset("linux")),
  );
  assert(
    "windows 托盘图标是 ico",
    trayIconAsset("windows").endsWith(`${path.sep}tray.ico`) && fs.existsSync(trayIconAsset("windows")),
  );

  // 平台行为矩阵（纯数据；不依赖宿主平台 —— Windows/macOS CI 也能覆盖）
  const windowsBehavior = resolveTrayPlatformBehavior("windows");
  assert(
    "windows 托盘行为：ico + 气泡提示 + 支持 balloon + 无降级驻留",
    windowsBehavior.iconFormat === "ico" &&
      windowsBehavior.hideHint === "balloon" &&
      windowsBehavior.supportsBalloon === true &&
      windowsBehavior.degradedResidency === false &&
      windowsBehavior.scaleToPx === undefined,
  );
  const linuxBehavior = resolveTrayPlatformBehavior("linux");
  assert(
    "linux 托盘行为：png + 22px + 桌面通知 + 降级驻留",
    linuxBehavior.iconFormat === "png" &&
      linuxBehavior.scaleToPx === 22 &&
      linuxBehavior.hideHint === "notification" &&
      linuxBehavior.supportsBalloon === false &&
      linuxBehavior.degradedResidency === true,
  );
  // 菜单绑定：Linux 必须 setContextMenu（popUpContextMenu 在 Linux 上是空操作）
  assert(
    "linux 右键菜单走 setContextMenu",
    linuxBehavior.menuBinding === "setContextMenu",
  );

  const macosBehavior = resolveTrayPlatformBehavior("macos");
  assert(
    "macos 托盘行为：ico + 不提示 + 无降级驻留",
    macosBehavior.iconFormat === "ico" &&
      macosBehavior.hideHint === "none" &&
      macosBehavior.supportsBalloon === false &&
      macosBehavior.degradedResidency === false,
  );
  assert(
    "windows/macOS 右键菜单走 popUpContextMenu",
    windowsBehavior.menuBinding === "popUpContextMenu" &&
      macosBehavior.menuBinding === "popUpContextMenu",
  );

  // 5.5) 菜单绑定：按 platform behavior 选择 setContextMenu / popUpContextMenu
  //      用 spy 替身托盘，验证「调用哪个 API」而不只是常量值。
  const menuWin = new BrowserWindow({ width: 320, height: 240, show: false });
  const spy = {
    tooltip: "",
    menu: null,
    popped: 0,
    handlers: new Map(),
    setToolTip(value) { this.tooltip = value; },
    on(event, handler) { this.handlers.set(event, handler); return this; },
    setContextMenu(menu) { this.menu = menu; },
    popUpContextMenu(menu) { this.popped += 1; this.menu = menu; },
    destroy() { this.destroyed = true; },
  };
  const menuSvc = new TrayService();
  menuSvc.initialize(menuWin, { createTray: () => spy });
  if (resolveTrayPlatformBehavior().menuBinding === "setContextMenu") {
    assert("Linux 用 setContextMenu 注册菜单（不是 popUpContextMenu）", spy.menu !== null && spy.popped === 0);
  } else {
    assert("Windows/macOS 关联 right-click → popUpContextMenu", typeof spy.handlers.get("right-click") === "function" && spy.menu === null);
    spy.handlers.get("right-click")();
    assert("Windows/macOS 右键会弹出菜单", spy.popped === 1 && spy.menu !== null);
  }
  const menuLabels = (spy.menu?.items ?? []).map((item) => item.label).filter(Boolean);
  assert("托盘菜单包含 显示/刷新/退出", ["显示 MyBuddy", "刷新", "退出"].every(label => menuLabels.includes(label)), menuLabels.join("|"));
  menuSvc.dispose();
  menuWin.destroy();

  // 6) 托盘后端失败：Linux 关窗仍驻留；Windows / macOS 保持原行为（不拦截、不抑制退出）
  const hidden = new BrowserWindow({ width: 320, height: 240, show: false });
  const failedTray = new TrayService();
  failedTray.initialize(hidden, {
    createTray() {
      throw new Error("status notifier unavailable");
    },
  });
  const failedEvent = makeCloseEvent();
  hidden.emit("close", failedEvent);
  assert("托盘失败时没有图标", failedTray.hasTray() === false);
  if (process.platform === "linux") {
    assert("托盘失败时 Linux 仍拦截关闭", failedEvent.defaultPrevented === true);
    assert("托盘失败时 Linux 仍抑制退出", failedTray.shouldSuppressQuit() === true);
    assert("托盘失败时窗口已隐藏", hidden.isVisible() === false);
  } else {
    assert("托盘失败时不拦截关闭", failedEvent.defaultPrevented === false);
    assert("托盘失败时不抑制退出", failedTray.shouldSuppressQuit() === false);
  }
  failedTray.dispose();
  assert("托盘失败后 dispose 不再驻留", failedTray.shouldSuppressQuit() === false);
  hidden.destroy();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
  win.destroy();
  cleanupSandboxProfile();
  app.exit(failed.length > 0 ? 1 : 0);
});
