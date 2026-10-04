/**
 * Wave 5A — Golden 截图（DPR matrix）
 *
 * 真实 Electron + 真实生产组件（CodeView / MarkdownArtifactView，经
 * build-wave5a-preview.mjs 打包）→ 截图存 fixtures/golden/wave5a/，供人工审查。
 * 与 screenshot-harness.cjs 同构：每 DPR 单独进程，窗口内循环场景。
 *
 * 场景（5A Gate 的视觉面）：
 *   md-features / md-rich / md-long（虚拟化长文档）
 *   code-ts-light / code-ts-dark（主题切换）/ code-large（10.9k 行虚拟列表）
 *   code-longline（横向滚动）/ code-edit（Monaco 编辑态）
 *
 * 运行：
 *   node scripts/build-wave5a-preview.mjs
 *   node_modules/.bin/electron.cmd scripts/wave5a-golden.cjs [--dpr 1.5] [--only <子串>]
 */
const { app, BrowserWindow, protocol } = require("electron");
const { join } = require("node:path");
const { mkdirSync, readdirSync, writeFileSync } = require("node:fs");

const ROOT = join(__dirname, "..");
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");
const GOLDEN = join(ROOT, "fixtures", "golden", "wave5a");
const PAGE = "file:///" + join(ROOT, "fixtures", "golden-pages", "wave5a-preview.html").replace(/\\/g, "/");

const args = process.argv.slice(2);
const dprArg = args.includes("--dpr") ? args[args.indexOf("--dpr") + 1] : "1.0";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const DPR = Number(dprArg);

app.commandLine.appendSwitch("force-device-scale-factor", String(DPR));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 场景清单：name → query 参数 + 就绪条件 */
const SCENARIOS = [
  { name: "md-features", query: "?file=markdown-features.md&kind=markdown", ready: ".md-section" },
  { name: "md-rich", query: "?file=markdown-rich.md&kind=markdown", ready: ".md-section" },
  { name: "md-long", query: "?file=markdown-long.md&kind=markdown", ready: ".md-section" },
  { name: "code-ts-light", query: "?file=code-ts.ts&lang=typescript", ready: ".shiki-line span" },
  { name: "code-ts-dark", query: "?file=code-ts.ts&lang=typescript&theme=dark", ready: ".shiki-line span" },
  { name: "code-large", query: "?file=code-large.ts&lang=typescript", ready: ".code-view-virtual-row" },
  { name: "code-longline", query: "?file=code-longline.ts&lang=typescript", ready: ".shiki-line span" },
  { name: "code-edit", query: "?file=code-medium.ts&lang=typescript&edit=1", ready: ".monaco-editor" },
];

async function waitForReady(wc, selector, timeout = 20000) {
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
  console.log(`[wave5a-golden] DPR=${DPR}  场景: ${targets.map((t) => t.name).join(", ")}`);

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

  // 仅测试页：允许 file:// 页面 fetch 自定义协议（生产 CSP/协议不受影响）
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
      await sleep(target.ready === ".monaco-editor" ? 1500 : 700); // 布局/高亮/编辑态稳定
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
  console.log(`[wave5a-golden] manifest → ${manifestPath}`);
  console.log(failures === 0 ? "ALL OK" : `${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
}

run();
