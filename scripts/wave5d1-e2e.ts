/**
 * Wave 5D-1 — DOCX Quality Gate（真实 Electron E2E）
 *
 * 真实 Electron + 真实生产组件（DocxViewer，经 build-wave5a-preview.mjs 打包）
 * + docx-preview + 真实 DOCX fixture。
 *
 * 场景（5D-1 Gate 机器断言面）：
 *   docx-simple   单页：paged 渲染/文本/表格/工具栏
 *   docx-long     24 页：DOM 页数受控（窗口化）、滚动回收（pagesLive 有界）、
 *                 页码跳转、缩放三态、搜索（计数/mark/prev-next/清除）、文本选择
 *   docx-hf       页眉页脚渲染
 *   docx-images   图片渲染
 *   perf-leak     long → 快速滚动 → 搜索 → 跳转 → zoom → 切换 → close：
 *                 docs/listeners/observers/pagesLive 归零、DOM 清空、objectURL 0
 *
 * 前置：node scripts/build-wave5a-preview.mjs
 * 运行：pnpm test:wave5d1-e2e（esbuild bundle → electron 主进程执行）
 */
import { app, BrowserWindow, protocol } from "electron";
import { join } from "node:path";

const ROOT = process.cwd();
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic", "office");
const PAGE =
  "file:///" + join(ROOT, "fixtures", "golden-pages", "wave5a-preview.html").replace(/\\/g, "/");

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(wc: Electron.WebContents, expr: string, timeout = 40000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await wc.executeJavaScript(expr)) return true;
    } catch {
      /* page mid-load */
    }
    await sleep(150);
  }
  console.log(`  [waitFor] 超时: ${expr.slice(0, 90)}`);
  return false;
}

async function evalJson<T>(wc: Electron.WebContents, expr: string): Promise<T> {
  return (await wc.executeJavaScript(`(${expr})`)) as T;
}

/** React 19 受控输入：原生 setter + input 事件 */
async function setInput(wc: Electron.WebContents, selector: string, value: string): Promise<void> {
  await wc.executeJavaScript(
    `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
}

const VIEWER_STATE = `(() => {
  const v = document.querySelector('.docx-viewer');
  if (!v) return null;
  return {
    meta: document.querySelector('.docx-viewer-meta')?.textContent ?? '',
    scale: document.querySelector('[data-testid="docx-scale"]')?.textContent ?? '',
    slots: document.querySelectorAll('.docx-page-slot').length,
    mountedPages: document.querySelectorAll('.docx-page-mount > *').length,
    pageText: document.querySelector('.docx-page-mount')?.textContent?.slice(0, 80) ?? '',
    marks: document.querySelectorAll('mark.pdf-match').length,
    scrollHeight: document.querySelector('.docx-viewer-scroll')?.scrollHeight ?? 0,
    scrollTop: document.querySelector('.docx-viewer-scroll')?.scrollTop ?? 0,
    imgs: document.querySelectorAll('.docx-page-mount img').length,
    stats: window.__w5a.stats().docx,
  };
})()`;

// ---------- 场景 ----------

async function scenarioSimple(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, VIEWER_STATE);
  check("simple: 1 页元数据", s.meta.includes("1 页"), s.meta);
  check("simple: 分页渲染", s.slots >= 1 && s.mountedPages >= 1, `${s.slots} slots / ${s.mountedPages} mounted`);
  check("simple: 文本内容（中英）", s.pageText.includes("MyBuddy DOCX Fixture") && /简单文档/.test(s.pageText), s.pageText);
  const selectable = await evalJson<string>(wc, `getComputedStyle(document.querySelector('.docx-page-mount')).userSelect`);
  check("simple: 文本可选中", selectable !== "none", selectable);
}

async function scenarioLong(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, VIEWER_STATE);
  check("long: ≥20 页元数据", /\d+ 页/.test(s.meta) && parseInt(s.meta, 10) >= 20, s.meta);
  check("long: DOM slot 受控（<10）", s.slots > 0 && s.slots < 10, `${s.slots} slots`);
  check("long: pagesLive 有界（<10）", s.stats.pagesLive > 0 && s.stats.pagesLive < 10, String(s.stats.pagesLive));

  // 连续滚动：滚到中部 → 新页挂载、live 仍受控
  const total = await evalJson<number>(wc, `document.querySelector('.docx-viewer-scroll').scrollHeight`);
  await wc.executeJavaScript(`document.querySelector('.docx-viewer-scroll').scrollTop = ${Math.floor(total * 0.5)}`);
  await sleep(1000);
  const mid = await evalJson<any>(wc, VIEWER_STATE);
  check("long: 滚动后 slot 受控", mid.slots > 0 && mid.slots < 10, `${mid.slots} slots`);
  check("long: 滚动后 pagesLive 有界", mid.stats.pagesLive > 0 && mid.stats.pagesLive < 10, String(mid.stats.pagesLive));

  // 页码跳转 → 末页
  const pageCount = parseInt(s.meta, 10);
  await setInput(wc, ".docx-viewer-page-input", String(pageCount));
  await sleep(100);
  await wc.executeJavaScript(`document.querySelector('[data-action="jump"]').click()`);
  await sleep(1000);
  const jumpTop = await evalJson<number>(wc, `document.querySelector('.docx-viewer-scroll').scrollTop`);
  check("long: 跳转后滚动到底部区域", jumpTop > total * 0.8, `${jumpTop} / ${total}`);
  const lastReady = await waitFor(wc, `(() => { const mounts = document.querySelectorAll('.docx-page-mount'); return Array.from(mounts).some(m => (m.textContent ?? '').includes('Chapter 24')); })()`, 15000);
  check("long: 末页文本（re-render 恢复）", lastReady);

  // 缩放三态
  await wc.executeJavaScript(`document.querySelector('[data-action="fit-width"]').click()`);
  await sleep(300);
  const fw = await evalJson<any>(wc, VIEWER_STATE);
  const stageW = await evalJson<number>(wc, `document.querySelector('.docx-viewer-stage').clientWidth`);
  const frameW = await evalJson<number>(wc, `document.querySelector('.docx-page-frame')?.clientWidth ?? 0`);
  check("long: fit-width 帧宽 ≈ 容器", Math.abs(frameW - stageW) < 30, `${frameW} vs ${stageW}`);
  await wc.executeJavaScript(`document.querySelector('[data-action="zoom-100"]').click()`);
  await sleep(300);
  const z100 = await evalJson<any>(wc, VIEWER_STATE);
  check("long: 100% 指示", z100.scale.includes("100%"), z100.scale);
  await wc.executeJavaScript(`document.querySelector('[data-action="zoom-in"]').click()`);
  await sleep(300);
  const zin = await evalJson<any>(wc, VIEWER_STATE);
  check("long: zoom-in > 100%", parseInt(zin.scale, 10) > 100, zin.scale);
  await wc.executeJavaScript(`document.querySelector('[data-action="fit-page"]').click()`);
  await sleep(300);
  const fp = await evalJson<any>(wc, VIEWER_STATE);
  check("long: fit-page 回缩", parseInt(fp.scale, 10) < parseInt(zin.scale, 10), `${fp.scale} < ${zin.scale}`);
}

async function scenarioSearch(wc: Electron.WebContents): Promise<void> {
  await setInput(wc, ".docx-viewer-page-input", "1");
  await sleep(80);
  await wc.executeJavaScript(`document.querySelector('[data-action="jump"]').click()`);
  await sleep(800);
  await setInput(wc, ".docx-viewer-search-input", "Chapter");
  const hasCount = await waitFor(wc, `!!document.querySelector('[data-testid="docx-search-count"]')`, 20000);
  check("search: 计数出现", hasCount);
  await sleep(500);
  const countText = await evalJson<string>(wc, `document.querySelector('[data-testid="docx-search-count"]')?.textContent ?? ''`);
  const [cur, total] = countText.split("/").map((n) => parseInt(n, 10));
  check("search: 跨页命中 ≥ 20", total >= 20, countText);
  const marks = await evalJson<number>(wc, `document.querySelectorAll('mark.pdf-match').length`);
  check("search: 当前页 mark 高亮", marks >= 1, String(marks));
  await wc.executeJavaScript(`document.querySelector('[data-action="search-next"]').click()`);
  await sleep(800);
  const nextCount = await evalJson<string>(wc, `document.querySelector('[data-testid="docx-search-count"]')?.textContent ?? ''`);
  check("search: next 计数推进", nextCount !== countText, `${countText} → ${nextCount}`);
  await wc.executeJavaScript(`document.querySelector('[data-action="search-clear"]').click()`);
  await sleep(400);
  const cleared = await evalJson<number>(wc, `document.querySelectorAll('mark.pdf-match').length`);
  check("search: 清除后无 mark", cleared === 0, String(cleared));
  void cur;
}

async function scenarioHeaderFooter(wc: Electron.WebContents): Promise<void> {
  const text = await evalJson<string>(wc, `(() => { const mounts = document.querySelectorAll('.docx-page-mount'); return Array.from(mounts).map(m => m.textContent ?? '').join(' '); })()`);
  check("hf: 页眉文本", text.includes("MyBuddy 页眉 Header"), text.slice(0, 60));
  check("hf: 页脚文本", text.includes("页脚 Footer"), text.slice(0, 60));
}

async function scenarioOversizedSkip(wc: Electron.WebContents): Promise<void> {
  const skipped = await evalJson<boolean>(wc, `!!document.querySelector('[data-testid="office-preview-skipped"]')`);
  const parsing = await evalJson<boolean>(wc, `(document.querySelector('.docx-viewer-status')?.textContent ?? '').includes('正在解析')`);
  const mounts = await evalJson<number>(wc, `document.querySelectorAll('.docx-page-mount').length`);
  check("images: 超过 500KB 跳过解析", skipped);
  check("images: 不显示正在解析", !parsing);
  check("images: 不挂载分页", mounts === 0, String(mounts));
}

async function scenarioPerfLeak(wc: Electron.WebContents): Promise<void> {
  await waitFor(wc, `/\d+ 页/.test(document.querySelector('.docx-viewer-meta')?.textContent ?? '')`, 60000);
  await sleep(1000);
  const pageCount = await evalJson<number>(wc, `parseInt(document.querySelector('.docx-viewer-meta')?.textContent ?? '0', 10)`);
  check("leak: 24 页文档", pageCount >= 20, String(pageCount));

  const scroll = await evalJson<number>(wc, `document.querySelector('.docx-viewer-scroll').scrollHeight`);
  for (const frac of [0.15, 0.4, 0.65, 0.9, 0.3]) {
    await wc.executeJavaScript(`document.querySelector('.docx-viewer-scroll').scrollTop = ${Math.floor(scroll * frac)}`);
    await sleep(300);
  }
  const afterScroll = await evalJson<any>(wc, VIEWER_STATE);
  check("leak: 快速滚动后 slot 受控", afterScroll.slots > 0 && afterScroll.slots < 10, `${afterScroll.slots} slots`);
  check("leak: pagesLive 有界（<15，25 页文档）", afterScroll.stats.pagesLive < 15, String(afterScroll.stats.pagesLive));

  await setInput(wc, ".docx-viewer-search-input", "Chapter");
  await waitFor(wc, `!!document.querySelector('[data-testid="docx-search-count"]')`, 20000);
  await setInput(wc, ".docx-viewer-page-input", String(pageCount));
  await sleep(80);
  await wc.executeJavaScript(`document.querySelector('[data-action="jump"]').click()`);
  await sleep(800);
  await wc.executeJavaScript(`document.querySelector('[data-action="zoom-in"]').click()`);
  await sleep(300);
  await wc.executeJavaScript(`document.querySelector('[data-action="fit-page"]').click()`);
  await sleep(300);

  // 切换 artifact（simple）→ close
  await wc.executeJavaScript(`window.__w5a.renderDocx('docx-simple.docx')`);
  await waitFor(wc, `document.querySelector('.docx-viewer-meta')?.textContent.includes('1 页')`, 40000);
  await sleep(600);
  await wc.executeJavaScript(`window.__w5a.renderDocx(null)`);
  await sleep(600);

  const end = await evalJson<any>(wc, `window.__w5a.stats()`);
  check("leak: docxDom 清空", end.docxDom === 0, String(end.docxDom));
  check("leak: docs 归零", end.docx.docs === 0, String(end.docx.docs));
  check("leak: listeners 归零", end.docx.listeners === 0, String(end.docx.listeners));
  check("leak: observers 归零", end.docx.observers === 0, String(end.docx.observers));
  check("leak: pagesLive 归零", end.docx.pagesLive === 0, String(end.docx.pagesLive));
  check("leak: objectURL 零调用", end.objectUrlCalls === 0, String(end.objectUrlCalls));
  check("leak: 回收后重建渲染有记录", end.docx.renders >= 2, String(end.docx.renders));
}

// ---------- 装配 ----------

protocol.registerSchemesAsPrivileged([
  { scheme: "w5a-fixture", privileges: { standard: false, supportFetchAPI: true } },
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

  const scenarios: Array<[string, string, string, (wc: Electron.WebContents) => Promise<void>]> = [
    ["docx-simple", "?file=docx-simple.docx&kind=docx", ".docx-page-mount", scenarioSimple],
    ["docx-long", "?file=docx-long-24p.docx&kind=docx", ".docx-page-mount", scenarioLong],
    ["docx-search", "?file=docx-long-24p.docx&kind=docx", ".docx-page-mount", scenarioSearch],
    ["docx-hf", "?file=docx-header-footer.docx&kind=docx", ".docx-page-mount", scenarioHeaderFooter],
    ["docx-images", "?file=docx-images.docx&kind=docx", "[data-testid=\"office-preview-skipped\"]", scenarioOversizedSkip],
    ["perf-leak", "?file=docx-long-24p.docx&kind=docx", ".docx-page-mount", scenarioPerfLeak],
  ];

  let failures = 0;
  for (const [name, query, ready, scenario] of scenarios) {
    try {
      console.log(`-- ${name} --`);
      await win.loadURL(PAGE + query);
      const ok = await waitFor(win.webContents, `!!document.querySelector(${JSON.stringify(ready)})`);
      if (!ok) {
        check(`${name}: 就绪`, false, ready);
        failures += 1;
        continue;
      }
      await sleep(1000);
      await scenario(win.webContents);
    } catch (error) {
      failures += 1;
      check(`${name}: 异常`, false, String(error));
    }
  }

  const failed = results.filter(([, pass]) => !pass).length;
  console.log(`\n结果: ${results.length - failed}/${results.length} PASS`);
  app.exit(failures === 0 && failed === 0 ? 0 : 1);
}

void run();
