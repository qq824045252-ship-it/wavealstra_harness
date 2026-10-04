/**
 * Wave 5B — Golden 截图（DPR matrix，§87）
 *
 * 真实 Electron + 真实生产组件（ImageArtifactView）→ 截图存
 * fixtures/golden/wave5b/，供人工审查。每 DPR 单独进程（Electron 约束）。
 *
 * 场景：
 *   img-basic      常规 PNG fit（浅色）
 *   img-dark       常规 PNG fit（深色主题）
 *   img-transparent 透明 PNG + 棋盘格
 *   img-exif        EXIF 旋转 JPEG（竖显）
 *   img-8k          8K fit（降采样）
 *   img-zoom        100% 缩放态（带 pan 后的细节）
 *   img-tall        超高图 fit-width（贴顶 + 底部提示）
 *
 * 运行：
 *   node scripts/build-wave5a-preview.mjs
 *   node_modules/.bin/electron.cmd scripts/wave5b-golden.cjs [--dpr 1.5] [--only <子串>]
 */
const { app, BrowserWindow, protocol } = require("electron");
const { join } = require("node:path");
const { mkdirSync, writeFileSync } = require("node:fs");

const ROOT = join(__dirname, "..");
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");
const GOLDEN = join(ROOT, "fixtures", "golden", "wave5b");
const PAGE = "file:///" + join(ROOT, "fixtures", "golden-pages", "wave5a-preview.html").replace(/\\/g, "/");

const args = process.argv.slice(2);
const dprArg = args.includes("--dpr") ? args[args.indexOf("--dpr") + 1] : "1.0";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const DPR = Number(dprArg);

app.commandLine.appendSwitch("force-device-scale-factor", String(DPR));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = [
  { name: "img-basic", query: "?file=image-basic.png&kind=image", ready: ".image-viewer-img" },
  { name: "img-dark", query: "?file=image-basic.jpg&kind=image&theme=dark", ready: ".image-viewer-img" },
  { name: "img-transparent", query: "?file=image-transparent.png&kind=image", ready: ".image-viewer-img--alpha" },
  { name: "img-exif", query: "?file=image-exif-rotated.jpg&kind=image", ready: ".image-viewer-img" },
  { name: "img-8k", query: "?file=image-8k.png&kind=image", ready: ".image-viewer-img" },
  { name: "img-zoom", query: "?file=image-8k.png&kind=image&zoom=100", ready: ".image-viewer-img" },
  { name: "img-tall", query: "?file=image-tall.png&kind=image", ready: ".image-viewer-img" },
];

async function waitForReady(wc, selector, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await wc.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
    );
    if (ok) return true;
    await sleep(120);
  }
  console.log(`  [waitForReady] 超时: ${selector}`);
  return false;
}

async function run() {
  mkdirSync(GOLDEN, { recursive: true });
  const targets = SCENARIOS.filter((s) => !only || s.name.includes(only));
  console.log(`[wave5b-golden] DPR=${DPR}  场景: ${targets.map((t) => t.name).join(", ")}`);

  protocol.registerSchemesAsPrivileged([
    { scheme: "w5a-fixture", privileges: { standard: false, supportFetchAPI: true } },
  ]);

  app.on("window-all-closed", () => {});
  await app.whenReady();
  protocol.registerFileProtocol("w5a-fixture", (request, callback) => {
    try {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      callback({ path: join(FIX, name) });
    } catch {
      callback({ error: -2 });
    }
  });

  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    webPreferences: { webSecurity: false },
  });
  const manifest = [];
  let failures = 0;

  for (const target of targets) {
    try {
      await win.loadURL(PAGE + target.query);
      const ready = await waitForReady(win.webContents, target.ready);
      if (!ready) throw new Error(`ready selector not found: ${target.ready}`);
      // 8K 缩略绘制在隐藏窗口较慢：等待双 rAF 让合成器推进后再截屏（避免旧帧）
      if (target.name.startsWith("img-8k") || target.name === "img-zoom") {
        await win.webContents.executeJavaScript(
          `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
        );
        await sleep(2500);
      } else {
        await sleep(target.name === "img-zoom" ? 1500 : 900);
      }
      const image = await win.webContents.capturePage();
      const name = `${target.name}@${dprArg}.png`;
      writeFileSync(join(GOLDEN, name), image.toPNG());
      manifest.push({ name, w: image.getSize().width, h: image.getSize().height, dpr: DPR, query: target.query });
      console.log(`  ${target.name.padEnd(16)} → ${name} (${image.getSize().width}x${image.getSize().height})`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL ${target.name}: ${error.message}`);
    }
  }

  const manifestPath = join(GOLDEN, `manifest-${dprArg}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`[wave5b-golden] manifest → ${manifestPath}`);
  console.log(failures === 0 ? "ALL OK" : `${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
}

run();
