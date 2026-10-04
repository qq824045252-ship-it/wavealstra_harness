/**
 * Wave 5D-2 — Golden 截图（DPR matrix，§88 / 1H spike：SheetJS + 自绘）
 *
 * 真实 Electron + 真实生产组件（XlsxViewer，经 build-wave5a-preview.mjs 打包）
 * + SheetJS 解析 + 真实 XLSX fixture → fixtures/golden/wave5d2/，供人工审查。
 * 每 DPR 单独进程（Electron 约束）。
 *
 * 场景：
 *   xlsx-simple    基础表（表头粗体）
 *   xlsx-multi     多 sheet 工作簿
 *   xlsx-frozen    冻结窗格（行+列）
 *   xlsx-merged    合并单元格
 *   xlsx-formats   格式与样式（日期/百分比/货币/填充/边框）
 *   xlsx-formula   公式缓存结果
 *   xlsx-10k30     万行大表（行号可见）
 *
 * 运行：
 *   node scripts/build-wave5a-preview.mjs
 *   node_modules/.bin/electron.cmd scripts/wave5d2-golden.cjs [--dpr 1.5] [--only <子串>]
 */
const { app, BrowserWindow, protocol } = require("electron");
const { join } = require("node:path");
const { mkdirSync, writeFileSync } = require("node:fs");

const ROOT = join(__dirname, "..");
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic", "office");
const GOLDEN = join(ROOT, "fixtures", "golden", "wave5d2");
const PAGE = "file:///" + join(ROOT, "fixtures", "golden-pages", "wave5a-preview.html").replace(/\\/g, "/");

const args = process.argv.slice(2);
const dprArg = args.includes("--dpr") ? args[args.indexOf("--dpr") + 1] : "1.0";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const DPR = Number(dprArg);

app.commandLine.appendSwitch("force-device-scale-factor", String(DPR));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = [
  { name: "xlsx-simple", query: "?file=xlsx-simple.xlsx&kind=xlsx", ready: ".xlsx-cell" },
  { name: "xlsx-multi", query: "?file=xlsx-multi.xlsx&kind=xlsx", ready: ".xlsx-cell" },
  { name: "xlsx-frozen", query: "?file=xlsx-frozen.xlsx&kind=xlsx", ready: ".xlsx-frozen-row .xlsx-cell" },
  { name: "xlsx-merged", query: "?file=xlsx-merged.xlsx&kind=xlsx", ready: ".xlsx-merge" },
  { name: "xlsx-formats", query: "?file=xlsx-formats.xlsx&kind=xlsx", ready: ".xlsx-cell" },
  { name: "xlsx-formula", query: "?file=xlsx-formula.xlsx&kind=xlsx", ready: ".xlsx-cell" },
  { name: "xlsx-10k30", query: "?file=xlsx-10k30.xlsx&kind=xlsx", ready: ".xlsx-frozen-row .xlsx-cell" },
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
  console.log(`[wave5d2-golden] DPR=${DPR}  场景: ${targets.map((t) => t.name).join(", ")}`);

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
    width: 1200,
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
      await sleep(1500);
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
  console.log(`[wave5d2-golden] manifest → ${manifestPath}`);
  console.log(failures === 0 ? "ALL OK" : `${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
}

run();
