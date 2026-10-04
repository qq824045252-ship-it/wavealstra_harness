/**
 * Wave 5D-1 — Golden 截图（DPR matrix，§88 / 1H spike：docx-preview）
 *
 * 真实 Electron + 真实生产组件（DocxViewer，经 build-wave5a-preview.mjs 打包）
 * + docx-preview + 真实 DOCX fixture → fixtures/golden/wave5d1/，供人工审查。
 * 每 DPR 单独进程（Electron 约束）。
 *
 * 场景：
 *   docx-simple   1 页文档（fit-page）
 *   docx-long     25 页长文档（窗口化，当前页可见）
 *   docx-table    复杂表格页
 *   docx-images   图片页
 *   docx-hf       页眉页脚
 *   docx-zoom     100% 缩放态
 *   docx-dark     深色主题
 *
 * 运行：
 *   node scripts/build-wave5a-preview.mjs
 *   node_modules/.bin/electron.cmd scripts/wave5d1-golden.cjs [--dpr 1.5] [--only <子串>]
 */
const { app, BrowserWindow, protocol } = require("electron");
const { join } = require("node:path");
const { mkdirSync, writeFileSync } = require("node:fs");

const ROOT = join(__dirname, "..");
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic", "office");
const GOLDEN = join(ROOT, "fixtures", "golden", "wave5d1");
const PAGE = "file:///" + join(ROOT, "fixtures", "golden-pages", "wave5a-preview.html").replace(/\\/g, "/");

const args = process.argv.slice(2);
const dprArg = args.includes("--dpr") ? args[args.indexOf("--dpr") + 1] : "1.0";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const DPR = Number(dprArg);

app.commandLine.appendSwitch("force-device-scale-factor", String(DPR));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = [
  { name: "docx-simple", query: "?file=docx-simple.docx&kind=docx", ready: ".docx-page-mount" },
  { name: "docx-long", query: "?file=docx-long-24p.docx&kind=docx", ready: ".docx-page-mount" },
  { name: "docx-table", query: "?file=docx-table.docx&kind=docx", ready: ".docx-page-mount" },
  { name: "docx-images", query: "?file=docx-images.docx&kind=docx", ready: ".docx-page-mount img" },
  { name: "docx-hf", query: "?file=docx-header-footer.docx&kind=docx", ready: ".docx-page-mount" },
  { name: "docx-zoom", query: "?file=docx-simple.docx&kind=docx&docxzoom=100", ready: ".docx-page-mount" },
  { name: "docx-dark", query: "?file=docx-long-24p.docx&kind=docx&theme=dark", ready: ".docx-page-mount" },
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
  console.log(`[wave5d1-golden] DPR=${DPR}  场景: ${targets.map((t) => t.name).join(", ")}`);

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
      // 文本/图片渲染稳定
      await sleep(1600);
      await win.webContents.executeJavaScript(
        `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
      );
      const image = await win.webContents.capturePage();
      const name = `${target.name}@${dprArg}.png`;
      writeFileSync(join(GOLDEN, name), image.toPNG());
      manifest.push({ name, w: image.getSize().width, h: image.getSize().height, dpr: DPR, query: target.query });
      console.log(`  ${target.name.padEnd(13)} → ${name} (${image.getSize().width}x${image.getSize().height})`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL ${target.name}: ${error.message}`);
    }
  }

  const manifestPath = join(GOLDEN, `manifest-${dprArg}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`[wave5d1-golden] manifest → ${manifestPath}`);
  console.log(failures === 0 ? "ALL OK" : `${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
}

run();
