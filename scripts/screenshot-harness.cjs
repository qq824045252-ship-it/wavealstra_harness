/**
 * Wave 1E — Screenshot / Golden Harness（V3.5 §47-51）
 *
 * fixture → 启动测试页 → 自动截图 → 存 PNG → 人工确认 baseline。
 * 第一版不自动 diff；golden 仅在人工确认质量后成为 baseline（§50）。
 *
 * 运行：
 *   node_modules/.bin/electron.cmd scripts/screenshot-harness.cjs [--view window|wcv] [--dpr 1.5] [--only <子串>]
 *
 * 注意：force-device-scale-factor 必须在 app ready 前设置，且 Electron 最后一个
 * 窗口关闭会触发 app 退出——因此每个 DPR 单独启动一次进程，窗口内循环所有目标。
 * 输出：
 *   fixtures/golden/<name>@<dpr>.png
 *   fixtures/golden/manifest.json  （尺寸/时间/参数）
 *
 * 覆盖：
 *   - window 模式：BrowserWindow 加载 fixture（html/svg 原生可渲染）
 *   - wcv 模式（§49）：WebContentsView 独立截图，验证 Renderer 截图不含 Native View
 *   - DPR matrix（§51）：--dpr 1.0,1.25,1.5,2.0
 */
const { app, BrowserWindow, WebContentsView } = require("electron");
const { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, basename } = require("node:path");

const FIXTURES = join(__dirname, "..", "fixtures", "artifacts", "synthetic");
const GOLDEN = join(__dirname, "..", "fixtures", "golden");

const args = process.argv.slice(2);
const viewMode = args.includes("--view") ? args[args.indexOf("--view") + 1] : "window";
const dprArg = args.includes("--dpr") ? args[args.indexOf("--dpr") + 1] : "1.0";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const DPR = Number(dprArg.split(",")[0]); // 单 DPR/进程（见文件头注释）

// 必须在 app ready 前设置才生效（Electron 命令行开关约束）
app.commandLine.appendSwitch("force-device-scale-factor", String(DPR));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = [];
let failures = [];

/** 收集可截图条目：html-basic/index.html → html-basic；html-relative-assets → 同；*.svg 单文件 */
function collectTargets() {
  const out = [];
  for (const entry of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const idx = join(FIXTURES, entry.name, "index.html");
      if (existsSync(idx)) out.push({ name: entry.name, url: "file:///" + idx.replace(/\\/g, "/"), file: idx });
    } else if (entry.name.endsWith(".svg")) {
      const p = join(FIXTURES, entry.name);
      out.push({ name: entry.name.replace(/\.svg$/, ""), url: "file:///" + p.replace(/\\/g, "/"), file: p });
    }
  }
  return out.filter((t) => !only || t.name.includes(only));
}

async function captureInWindow(win, target, dpr) {
  await win.loadURL(target.url);
  await sleep(500); // 布局/字体/脚本稳定
  const image = await win.webContents.capturePage();
  const name = `${target.name}@${dpr}.png`;
  writeFileSync(join(GOLDEN, name), image.toPNG());
  const size = win.webContents.getLastWebPreferences?.() ?? {};
  return { name, w: image.getSize().width, h: image.getSize().height };
}

async function captureInWcv(win, target, dpr) {
  const view = new WebContentsView({ webPreferences: { sandbox: true } });
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  win.contentView.addChildView(view);
  await view.webContents.loadURL(target.url);
  await sleep(500);
  const image = await view.webContents.capturePage();
  win.contentView.removeChildView(view);
  view.webContents.destroy();
  const name = `${target.name}@${dpr}.png`;
  writeFileSync(join(GOLDEN, name), image.toPNG());
  return { name, w: image.getSize().width, h: image.getSize().height };
}

async function run() {
  const targets = collectTargets();
  if (!targets.length) {
    console.log("没有可截图 fixture（fixtures/artifacts/synthetic 下 html 目录或 svg 文件）");
    app.exit(1);
    return;
  }
  console.log(`[harness] 目标: ${targets.map((t) => t.name).join(", ")}`);
  console.log(`[harness] DPR=${DPR}  模式: ${viewMode}`);
  mkdirSync(GOLDEN, { recursive: true });

  // 防“最后窗口关闭 → app 退出”（否则多目标循环中途退出）
  app.on("window-all-closed", () => {});

  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  await win.loadURL("about:blank");
  await sleep(200);
  for (const target of targets) {
    try {
      const shot = viewMode === "wcv"
        ? await captureInWcv(win, target, DPR)
        : await captureInWindow(win, target, DPR);
      manifest.push({ ...shot, fixture: target.file, mode: viewMode, dpr: DPR, at: new Date().toISOString() });
      console.log(`  OK  ${shot.name}  ${shot.w}x${shot.h}`);
    } catch (e) {
      failures.push(`${target.name}@${DPR}: ${e.message}`);
      console.log(`  ERR ${target.name}@${DPR}  ${e.message.slice(0, 100)}`);
    }
  }
  win.destroy();
  await sleep(200);

  // 合并模式：保留历史 DPR 档（§51 matrix），按 name 去重（新截图覆盖旧条目）
  let existing = [];
  try {
    existing = JSON.parse(readFileSync(join(GOLDEN, "manifest.json"), "utf-8"));
  } catch (e) {
    console.log("[harness] manifest 读取失败（按空合并）:", e.code, e.message.slice(0, 140));
  }
  const byName = new Map(existing.map((m) => [m.name, m]));
  for (const e of manifest) byName.set(e.name, e);
  const merged = [...byName.values()];
  writeFileSync(join(GOLDEN, "manifest.json"), JSON.stringify(merged, null, 2), "utf-8");
  console.log(`\n===== Harness 完成: 本次 ${manifest.length} 张，manifest 累计 ${merged.length} 条（按 name 去重合并） =====`);
  if (failures.length) console.log("失败:\n  - " + failures.join("\n  - "));
  console.log("下一步（§50）：人工确认每张截图达到目标质量后，才可作为 golden baseline。");
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(run).catch((e) => {
  console.error("[harness] 启动失败:", e);
  app.exit(1);
});
