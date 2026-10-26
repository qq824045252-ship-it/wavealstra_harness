/**
 * UI 用例共享的截图/等帧工具。
 *
 * 背景：`webContents.capturePage()` 在无 GPU / 无合成器（或纯 Wayland 会话、隐藏窗口）的
 * Linux 上要么永不 resolve（实测隐藏窗口 10s 无返回），要么直接抛 UnknownVizError。
 * consult-card-ui / expert-ui / memory-ui / settings-records-ui / project-activity-ui /
 * project-materials-ui 因此会在断言全部 PASS 后卡在截图步骤，直到各自 watchdog 判超时（45s~300s）。
 *
 * 截图只是诊断产物，不应让用例挂死：首次失败即判定本环境不支持截图，后续调用直接跳过，
 * 并打印一行提示。Windows/有 GPU 的环境行为不变（正常截图）。
 */
const { writeFileSync } = require("node:fs");

let captureUnsupported = false;

async function capturePageSafe(win, timeoutMs = 1500) {
  if (captureUnsupported) return null;
  if (!win || win.isDestroyed?.()) return null;
  const shot = win.webContents.capturePage().catch((error) => {
    console.warn(`[ui-capture] capturePage 失败（${error?.message ?? error}），本环境后续跳过截图`);
    captureUnsupported = true;
    return null;
  });
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const image = await Promise.race([shot, timer]);
  if (!image) {
    if (!captureUnsupported) {
      console.warn(`[ui-capture] capturePage 超过 ${timeoutMs}ms 未返回，本环境后续跳过截图`);
      captureUnsupported = true;
    }
    return null;
  }
  return image;
}

/** 截图落盘；返回是否真的写出（跳过时为 false，调用方不应据此判定失败）。 */
async function writeScreenshot(win, file, timeoutMs = 1500) {
  const image = await capturePageSafe(win, timeoutMs);
  if (!image) return false;
  writeFileSync(file, image.toPNG());
  return true;
}

/**
 * 页面内「等两帧」表达式。
 * 隐藏窗口 + 无合成器的 Linux 环境下 requestAnimationFrame 可能永不触发（页面被判定不可见），
 * 直接 await 会把整个用例拖到 watchdog 超时 → 用 400ms 定时器兜底，Windows 上仍是两帧语义。
 */
const settleFramesScript =
  "Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise(resolve => setTimeout(resolve, 400))])";

module.exports = { capturePageSafe, writeScreenshot, settleFramesScript };
