/**
 * Wave 5C — Golden 截图（DPR matrix，§86）
 *
 * 真实 Electron + 真实生产组件（PdfViewer，经 build-wave5a-preview.mjs 打包）
 * + 真实 pdfjs + 真实 PDF fixture → fixtures/golden/wave5c/，供人工审查。
 * 每 DPR 单独进程（Electron 约束）。
 *
 * 场景：
 *   pdf-simple        1 页文档（fit-page）
 *   pdf-normal        32 页文档（fit-page，文本层可见）
 *   pdf-zoom          32 页 100% 缩放态
 *   pdf-tables        表格+图表页
 *   pdf-scanned       扫描件（无文本层）
 *   pdf-landscape     横向页面
 *   pdf-dark          深色主题
 *
 * 运行：
 *   node scripts/build-wave5a-preview.mjs
 *   node_modules/.bin/electron.cmd scripts/wave5c-golden.cjs [--dpr 1.5] [--only <子串>]
 */
const { app, BrowserWindow, protocol } = require("electron");
const { join } = require("node:path");
const { mkdirSync, writeFileSync } = require("node:fs");

const ROOT = join(__dirname, "..");
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");
const GOLDEN = join(ROOT, "fixtures", "golden", "wave5c");
const PAGE = "file:///" + join(ROOT, "fixtures", "golden-pages", "wave5a-preview.html").replace(/\\/g, "/");

const args = process.argv.slice(2);
const dprArg = args.includes("--dpr") ? args[args.indexOf("--dpr") + 1] : "1.0";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const DPR = Number(dprArg);

app.commandLine.appendSwitch("force-device-scale-factor", String(DPR));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = [
  { name: "pdf-simple", query: "?file=pdf-simple.pdf&kind=pdf", ready: ".pdf-canvas" },
  { name: "pdf-normal", query: "?file=pdf-normal-40p.pdf&kind=pdf", ready: ".pdf-canvas" },
  { name: "pdf-zoom", query: "?file=pdf-normal-40p.pdf&kind=pdf&pdfzoom=100", ready: ".pdf-canvas" },
  { name: "pdf-tables", query: "?file=pdf-tables-images.pdf&kind=pdf", ready: ".pdf-canvas" },
  { name: "pdf-scanned", query: "?file=pdf-scanned.pdf&kind=pdf", ready: ".pdf-canvas" },
  { name: "pdf-landscape", query: "?file=pdf-landscape.pdf&kind=pdf", ready: ".pdf-canvas" },
  { name: "pdf-dark", query: "?file=pdf-normal-40p.pdf&kind=pdf&theme=dark", ready: ".pdf-canvas" },
];

async function waitForReady(wc, selector, timeout = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const ok = await wc.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}) !== null`,
      );
      if (ok) return true;
    } catch {
      /* 页面加载中 */
    }
    await sleep(150);
  }
  console.log(`  [waitForReady] 超时: ${selector}`);
  return false;
}

async function run() {
  mkdirSync(GOLDEN, { recursive: true });
  const targets = SCENARIOS.filter((s) => !only || s.name.includes(only));
  console.log(`[wave5c-golden] DPR=${DPR}  场景: ${targets.map((t) => t.name).join(", ")}`);

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
    width: 1100,
    height: 800,
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
      // 文本层与画布稳定；pdfzoom=100 时额外等待缩放切换
      if (target.query.includes("pdfzoom=100")) {
        await win.webContents.executeJavaScript(
          `(() => { const btn = document.querySelector('[data-action="zoom-100"]'); if (btn) btn.click(); return true; })()`,
        );
        await sleep(1500);
      } else {
        await sleep(1400);
      }
      await win.webContents.executeJavaScript(
        `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
      );
      const image = await win.webContents.capturePage();
      const name = `${target.name}@${dprArg}.png`;
      writeFileSync(join(GOLDEN, name), image.toPNG());
      manifest.push({ name, w: image.getSize().width, h: image.getSize().height, dpr: DPR, query: target.query });
      console.log(`  ${target.name.padEnd(14)} → ${name} (${image.getSize().width}x${image.getSize().height})`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL ${target.name}: ${error.message}`);
    }
  }

  const manifestPath = join(GOLDEN, `manifest-${dprArg}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`[wave5c-golden] manifest → ${manifestPath}`);
  console.log(failures === 0 ? "ALL OK" : `${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
}

run();
