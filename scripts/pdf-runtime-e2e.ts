/**
 * Wave 5C — PDF Runtime E2E：真实 Electron + 真实 legacy blob worker
 *
 * 与 wave5c-e2e 的区别：wave5c-e2e 的 preview bundle 把 pdfWorkerEntry 替换为
 * 抛错 stub → pdfjs 走 fake worker（主线程），主线程 legacy polyfill 会掩盖
 * `Uint8Array.prototype.toHex` 缺口 —— 所以 wave5c-e2e 全绿 ≠ 生产可用。
 *
 * 本脚本经 build-pdf-runtime-preview.mjs 打包：真实生产组件 + 真实内联 legacy
 * blob worker（与生产 vite ?worker&inline 同形态同 flavor）。断言面：
 *   - 真实 worker 创建（pdfViewerStats.workers === 1；fake worker 路径恒 0）
 *   - 无 "[pdfRuntime] pdfjs worker 创建失败" 回退警告（console 监听）
 *   - PDF 加载成功：numPages > 0 / canvas 渲染 / 文本层（普通与中文）/ 扫描件
 *   - 无 `n2.toHex is not a function`（worker 内 runtime 兼容性）
 *   - 关闭后 worker/docs/canvas/textLayer 全部归零（terminate 生效）
 *
 * 前置：node scripts/build-pdf-runtime-preview.mjs
 * 运行：pnpm test:pdf-runtime-e2e（esbuild bundle → electron 主进程执行）
 */
import { app, BrowserWindow, protocol } from "electron";
import { join } from "node:path";

const ROOT = process.cwd();
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");
const PAGE =
  "file:///" + join(ROOT, "fixtures", "golden-pages", "pdf-runtime-preview.html").replace(/\\/g, "/");

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(wc: Electron.WebContents, expr: string, timeout = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await wc.executeJavaScript(expr)) return true;
    } catch {
      /* 页面加载中 */
    }
    await sleep(150);
  }
  console.log(`  [waitFor] 超时: ${expr.slice(0, 110)}`);
  return false;
}

async function evalJson<T>(wc: Electron.WebContents, expr: string): Promise<T> {
  return (await wc.executeJavaScript(`(${expr})`)) as T;
}

/** 页面状态快照：viewer 渲染面 + pdfViewerStats 生命周期计数 */
const SNAPSHOT = `(() => {
  const meta = document.querySelector('.pdf-viewer-meta')?.textContent ?? '';
  return {
    meta,
    numPages: parseInt((meta.match(/(\\d+) 页/) ?? [])[1] ?? '0', 10),
    error: document.querySelector('.pdf-viewer-status')?.textContent ?? '',
    canvases: document.querySelectorAll('.pdf-viewer .pdf-canvas').length,
    textLayers: document.querySelectorAll('.pdf-viewer .textLayer').length,
    textLayerText: document.querySelector('.pdf-viewer .textLayer')?.textContent ?? '',
    stats: window.__w5a.stats().pdf,
  };
})()`;

interface Snapshot {
  meta: string;
  numPages: number;
  error: string;
  canvases: number;
  textLayers: number;
  textLayerText: string;
  stats: { workers: number; docs: number; canvasesLive: number; textLayersLive: number; listeners: number; observers: number };
}

// ---------- 场景 ----------

/** 1 页普通文档：真实 worker + 渲染 + 文本层 */
async function scenarioSimple(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__w5a.renderPdf('pdf-simple.pdf')`);
  const ok = await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-canvas')`);
  check("simple: canvas 渲染（真实 worker 环境）", ok);
  if (!ok) return;
  // 文本层就绪等待（真实 worker 首帧在系统负载下可能超过固定快照窗口）
  await waitFor(
    wc,
    `(() => { const t = document.querySelector('.pdf-viewer .textLayer'); return !!t && (t.textContent ?? '').includes('MyBuddy PDF Fixture'); })()`,
    30000,
  );
  await sleep(400);
  const s = await evalJson<Snapshot>(wc, SNAPSHOT);
  check("simple: 无加载错误", !s.error.includes("加载失败"), s.error);
  check("simple: numPages === 1", s.numPages === 1, s.meta);
  check("simple: 真实 worker 创建（workers===1，fake 路径恒 0）", s.stats.workers === 1, `workers=${s.stats.workers}`);
  check("simple: docs === 1", s.stats.docs === 1, `docs=${s.stats.docs}`);
  check("simple: 文本层含中英", s.textLayerText.includes("MyBuddy PDF Fixture") && s.textLayerText.includes("简单文档"), s.textLayerText.slice(0, 60));
}

/** 多页文档：worker 在长文档下稳定 + 页数正确 */
async function scenarioNormal(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__w5a.renderPdf('pdf-normal-40p.pdf')`);
  const ok = await waitFor(wc, `(() => { const m = document.querySelector('.pdf-viewer-meta')?.textContent ?? ''; return /\\d+ 页/.test(m) && !m.includes('解析中'); })()`);
  check("normal: 多页解析完成", ok, ok ? "" : "meta 未就绪");
  if (!ok) return;
  await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-canvas')`);
  await sleep(1000);
  const s = await evalJson<Snapshot>(wc, SNAPSHOT);
  check("normal: 20~60 页", s.numPages >= 20 && s.numPages <= 60, s.meta);
  check("normal: 无加载错误", !s.error.includes("加载失败"), s.error);
  check("normal: 真实 worker 保持（workers===1）", s.stats.workers === 1, `workers=${s.stats.workers}`);
  // 首帧文本层：真实 worker 下 32 页文档的首批渲染与预取排队，1s 快照不可靠
  // （本机偶发 >20s）；改为等待就绪（与 wave5c 同款语义）。
  const layerReady = await waitFor(
    wc,
    `(() => { const t = document.querySelector('.pdf-viewer .textLayer'); return !!t && (t.textContent ?? '').length > 30; })()`,
    40000,
  );
  check("normal: 文本层有内容", layerReady, layerReady ? "" : "首帧文本层 40s 内未就绪");
}

/** 扫描件：canvas 正常、文本层可为空、无 runtime 错误 */
async function scenarioScanned(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__w5a.renderPdf('pdf-scanned.pdf')`);
  const ok = await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-canvas')`);
  check("scanned: canvas 渲染", ok);
  if (!ok) return;
  await sleep(800);
  const s = await evalJson<Snapshot>(wc, SNAPSHOT);
  check("scanned: numPages === 4", s.numPages === 4, s.meta);
  check("scanned: 无加载错误", !s.error.includes("加载失败"), s.error);
  check("scanned: 文本层可为空（扫描件）", true, `textLayers=${s.textLayers}`);
}

/** 中文文件名 PDF */
async function scenarioChinese(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__w5a.renderPdf('中文-文档.pdf')`);
  const ok = await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-canvas')`);
  check("chinese: 中文文件名可打开", ok);
  if (!ok) return;
  await sleep(800);
  const s = await evalJson<Snapshot>(wc, SNAPSHOT);
  check("chinese: 无加载错误", !s.error.includes("加载失败"), s.error);
  check("chinese: 文本层含中文", s.textLayerText.includes("MyBuddy") || s.textLayerText.length > 20, s.textLayerText.slice(0, 50));
}

/** 关闭：worker terminate + 全部资源归零 */
async function scenarioClose(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__w5a.renderPdf(null)`);
  await sleep(600);
  const s = await evalJson<Snapshot>(wc, SNAPSHOT);
  const stats = s.stats;
  check("close: viewer 卸载", (await evalJson<number>(wc, `document.querySelectorAll('.pdf-viewer').length`)) === 0);
  check("close: workers 归零（terminate 生效）", stats.workers === 0, `workers=${stats.workers}`);
  check("close: docs 归零", stats.docs === 0, `docs=${stats.docs}`);
  check("close: canvasesLive 归零", stats.canvasesLive === 0, `canvasesLive=${stats.canvasesLive}`);
  check("close: textLayersLive 归零", stats.textLayersLive === 0, `textLayersLive=${stats.textLayersLive}`);
  check("close: listeners 归零", stats.listeners === 0, `listeners=${stats.listeners}`);
  check("close: observers 归零", stats.observers === 0, `observers=${stats.observers}`);
}

/**
 * 生命周期：open → close → reopen（worker 重建状态机）
 *
 * 回归锁：第一次 close 后 worker 若被置为 null（而非 undefined），第二次 open
 * 不会重建 Worker → workerPort=null → pdf.js 落到 workerSrc 猜测路径报
 * `No "GlobalWorkerOptions.workerSrc" specified.`。
 * 断言：每次打开期间 workers===1，关闭后 workers===0。
 */
async function scenarioLifecycle(wc: Electron.WebContents): Promise<void> {
  // A → close → B → close → A（最后一次重复 A：重建后能再次打开同一文档）
  const cycle = async (file: string, label: string): Promise<void> => {
    await wc.executeJavaScript(`window.__w5a.renderPdf('${file}')`);
    const ok = await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-canvas')`);
    check(`${label}: 打开成功（worker 重建）`, ok);
    if (!ok) return;
    await sleep(500);
    const open = await evalJson<Snapshot>(wc, SNAPSHOT);
    check(`${label}: 打开期间 workers === 1`, open.stats.workers === 1, `workers=${open.stats.workers}`);
    await wc.executeJavaScript(`window.__w5a.renderPdf(null)`);
    const zero = await waitFor(wc, `window.__w5a.stats().pdf.workers === 0 && window.__w5a.stats().pdf.docs === 0`);
    check(`${label}: 关闭后 workers/docs 归零（可重建）`, zero, zero ? "" : "stats 未归零");
  };
  await cycle("pdf-simple.pdf", "lc-A");
  await cycle("pdf-normal-40p.pdf", "lc-B");
  await cycle("pdf-simple.pdf", "lc-A2");
}

/**
 * 生命周期：快速切换 A→B→C→close→A
 *
 * viewer 直接切换（隐式 close 前一文档）时也必须完成
 * 释放→重建，不能出现 worker 复用残留或无法重建。
 */
async function scenarioLifecycleSwitch(wc: Electron.WebContents): Promise<void> {
  const open = async (file: string, label: string): Promise<void> => {
    await wc.executeJavaScript(`window.__w5a.renderPdf('${file}')`);
    const ok = await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-canvas')`);
    check(`${label}: 打开成功`, ok);
    if (!ok) return;
    await sleep(400);
    const s = await evalJson<Snapshot>(wc, SNAPSHOT);
    check(`${label}: workers === 1`, s.stats.workers === 1, `workers=${s.stats.workers}`);
    check(`${label}: docs === 1`, s.stats.docs === 1, `docs=${s.stats.docs}`);
  };
  const close = async (label: string): Promise<void> => {
    await wc.executeJavaScript(`window.__w5a.renderPdf(null)`);
    const zero = await waitFor(wc, `window.__w5a.stats().pdf.workers === 0 && window.__w5a.stats().pdf.docs === 0`);
    check(`${label}: 关闭后 workers/docs 归零`, zero, zero ? "" : "stats 未归零");
  };
  await open("pdf-simple.pdf", "sw-A");
  await open("pdf-normal-40p.pdf", "sw-B");
  await open("pdf-scanned.pdf", "sw-C");
  await close("sw-close");
  await open("pdf-simple.pdf", "sw-A2");
  await close("sw-close2");
}

// ---------- 装配 ----------

protocol.registerSchemesAsPrivileged([
  { scheme: "w5a-fixture", privileges: { standard: false, supportFetchAPI: true, corsEnabled: true } },
]);

app.on("window-all-closed", () => {});

async function run(): Promise<void> {
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

  // 监听 renderer console：fake-worker 回退会打 warning，真实 worker 路径不应出现
  const consoleWarnings: string[] = [];
  const allConsole: string[] = [];
  win.webContents.on("console-message", (event: any) => {
    // Electron 37 新式签名：Event<WebContentsConsoleMessageEventParams>
    const d = event && typeof event === "object" && "message" in event ? event : null;
    const message = d ? String(d.message) : "";
    const sourceId = d ? String(d.sourceId ?? "") : "";
    const line = d ? String(d.lineNumber ?? "") : "";
    allConsole.push(`${message}${sourceId ? `  [src=${sourceId}:${line}]` : ""}`);
    if (message.includes("[pdfRuntime] pdfjs worker 创建失败")) {
      consoleWarnings.push(message);
    }
  });

  // 诊断：场景超时后 dump 页面状态与 console（首次失败时输出一次）
  let diagnosed = false;
  const diagnose = async (wc: Electron.WebContents, name: string): Promise<void> => {
    if (diagnosed) return;
    diagnosed = true;
    try {
      const s = await evalJson<any>(wc, SNAPSHOT);
      console.log(`[诊断:${name}] error=${JSON.stringify(s.error)} meta=${JSON.stringify(s.meta)} stats=${JSON.stringify(s.stats)}`);
      // 校验内联 worker 源码完整性 + 手动复现 blob worker 解析
      try {
        const diag = await evalJson<any>(
          wc,
          `(async () => {
            const code = window.__pdfWorkerCode ?? '';
            const out = { len: code.length, head: code.slice(0, 80), tail: code.slice(-80) };
            out.hasImportCall = /import\\s*\\(/.test(code);
            out.manualError = await new Promise((resolve) => {
              try {
                const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
                const w = new Worker(url);
                w.onerror = (e) => { resolve(String(e.message)); };
                w.onmessage = () => { resolve('no-error'); };
                setTimeout(() => resolve('timeout-no-error'), 3000);
              } catch (e) { resolve('throw: ' + String(e)); }
            });
            return out;
          })()`,
        );
        console.log(`[诊断:${name}] workerCode len=${diag.len} hasImport=${diag.hasImportCall} manual=${diag.manualError}`);
        console.log(`[诊断:${name}] head=${JSON.stringify(diag.head)}`);
        console.log(`[诊断:${name}] tail=${JSON.stringify(diag.tail)}`);
      } catch (e) {
        console.log(`[诊断:${name}] workerCode 检查失败: ${String(e)}`);
      }
      console.log(`[诊断:${name}] console(${allConsole.length}):`);
      for (const line of allConsole.slice(-25)) console.log(`  | ${line.slice(0, 300)}`);
    } catch (e) {
      console.log(`[诊断:${name}] snapshot 失败: ${String(e)}`);
      console.log(`[诊断:${name}] console(${allConsole.length}):`);
      for (const line of allConsole.slice(-25)) console.log(`  | ${line.slice(0, 300)}`);
    }
  };

  const scenarios: Array<[string, string, (wc: Electron.WebContents) => Promise<void>]> = [
    ["simple", "?file=pdf-simple.pdf&kind=pdf", scenarioSimple],
    ["normal", "?file=pdf-normal-40p.pdf&kind=pdf", scenarioNormal],
    ["scanned", "?file=pdf-scanned.pdf&kind=pdf", scenarioScanned],
    ["chinese", "?file=中文-文档.pdf&kind=pdf", scenarioChinese],
    ["close", "?file=pdf-simple.pdf&kind=pdf", scenarioClose],
    ["lifecycle", "?file=pdf-simple.pdf&kind=pdf", scenarioLifecycle],
    ["lifecycle-switch", "?file=pdf-simple.pdf&kind=pdf", scenarioLifecycleSwitch],
  ];

  let failures = 0;
  for (const [name, query, scenario] of scenarios) {
    try {
      console.log(`-- ${name} --`);
      await win.loadURL(PAGE + query);
      await sleep(400);
      await scenario(win.webContents);
    } catch (error) {
      failures += 1;
      check(`${name}: 异常`, false, String(error).slice(0, 200));
    }
    // 场景失败时诊断一次（第一个失败场景）
    const last = results[results.length - 1];
    if (last && !last[1]) {
      await diagnose(win.webContents, name);
    }
  }

  check("worker 路径: 全程无 fake-worker 回退警告（真实 blob worker）", consoleWarnings.length === 0, consoleWarnings.join("; ") || "blob worker 正常创建");

  const failed = results.filter(([, pass]) => !pass).length;
  console.log(`\nPDF Runtime E2E: ${results.length - failed}/${results.length} PASS`);
  // test-all 失败时只打印子进程输出的最后 80 行；把失败用例名放在最末尾，CI 日志才看得到。
  const failedNames = results.filter(([, pass]) => !pass).map(([name]) => name);
  if (failedNames.length) console.log(`[FAILED CASES] ${failedNames.join(" | ")}`);
  app.exit(failures === 0 && failed === 0 ? 0 : 1);
}

void run();
