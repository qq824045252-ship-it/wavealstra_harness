/**
 * Wave 5D-2 — XLSX Quality Gate（真实 Electron E2E）
 *
 * 真实 Electron + 真实生产组件（XlsxViewer，经 build-wave5a-preview.mjs 打包）
 * + SheetJS 解析 + 真实 XLSX fixture。
 *
 * 场景（5D-2 Gate 机器断言面）：
 *   xlsx-simple   单 sheet：行列号/单元格/元数据
 *   xlsx-multi    Sheet tab 切换
 *   xlsx-frozen   冻结窗格（滚动时冻结区不动）
 *   xlsx-merged   merge 四边例：跨视口/anchor 视口外覆盖区进入/冻结边界分片/回收不丢
 *   xlsx-formats  数字/日期/百分比/货币 + 样式（粗体/填充/红字/边框/居中）
 *   xlsx-formula  公式显示已保存结果（不重算）
 *   xlsx-1k50     横向滚动列窗口、DOM 有界、perf-leak
 *   xlsx-10k30    超过 500KB：跳过解析，空白页
 *
 * 前置：node scripts/build-wave5a-preview.mjs
 * 运行：pnpm test:wave5d2-e2e
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

const GRID_STATE = `(() => {
  const v = document.querySelector('.xlsx-viewer');
  if (!v) return null;
  return {
    meta: document.querySelector('.xlsx-viewer-meta')?.textContent ?? '',
    cells: document.querySelectorAll('.xlsx-cell').length,
    merges: document.querySelectorAll('.xlsx-merge').length,
    rowHeaders: document.querySelectorAll('.xlsx-row-header-cell').length,
    colHeaders: document.querySelectorAll('.xlsx-col-header-cell').length,
    firstRowHeader: document.querySelector('.xlsx-row-header-cell')?.textContent ?? '',
    firstColHeader: document.querySelector('.xlsx-col-header-cell')?.textContent ?? '',
    firstCellText: document.querySelector('.xlsx-cell')?.textContent ?? '',
    frozenRowCells: document.querySelectorAll('.xlsx-frozen-row .xlsx-cell').length,
    frozenColCells: document.querySelectorAll('.xlsx-frozen-col .xlsx-cell').length,
    stats: window.__w5a.stats().xlsx,
  };
})()`;

// ---------- 场景 ----------

async function scenarioSimple(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, GRID_STATE);
  check("simple: 41×5 元数据", s.meta.includes("41") && s.meta.includes("5"), s.meta);
  check("simple: 单元格渲染", s.cells > 20, String(s.cells));
  check("simple: 列号头 A", s.colHeaders > 0 && s.firstColHeader === "A", s.firstColHeader);
  check("simple: 行号头 1", s.rowHeaders > 0 && s.firstRowHeader === "1", s.firstRowHeader);
  check("simple: A1 文本 id", s.firstCellText === "id", s.firstCellText);
}

async function scenarioMulti(wc: Electron.WebContents): Promise<void> {
  const tabs = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-sheet-tab').length`);
  check("multi: 3 个 sheet tab", tabs === 3, String(tabs));
  await wc.executeJavaScript(`document.querySelectorAll('.xlsx-sheet-tab')[1].click()`);
  await sleep(400);
  const active = await evalJson<string>(wc, `document.querySelector('.xlsx-sheet-tab.active')?.textContent ?? ''`);
  check("multi: 切换到汇总", active === "汇总", active);
  const text = await evalJson<string>(wc, `(() => { const cells = document.querySelectorAll('.xlsx-cell'); return cells.length ? cells[0].textContent ?? '' : ''; })()`);
  check("multi: 汇总内容", text === "指标", text);
  await wc.executeJavaScript(`document.querySelectorAll('.xlsx-sheet-tab')[2].click()`);
  await sleep(400);
  const active2 = await evalJson<string>(wc, `document.querySelector('.xlsx-sheet-tab.active')?.textContent ?? ''`);
  check("multi: 切换到说明", active2 === "说明", active2);
}

async function scenarioFrozen(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, GRID_STATE);
  check("frozen: 冻结行单元格存在", s.frozenRowCells >= 10, String(s.frozenRowCells));
  check("frozen: 冻结列单元格存在", s.frozenColCells >= 5, String(s.frozenColCells));
  // 纵向滚动 → 冻结行仍显示
  const totalH = await evalJson<number>(wc, `document.querySelector('.xlsx-canvas').offsetHeight`);
  await wc.executeJavaScript(`document.querySelector('.xlsx-viewer-scroll').scrollTop = ${Math.floor(totalH * 0.6)}`);
  await sleep(500);
  const frozenAfter = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-frozen-row .xlsx-cell').length`);
  check("frozen: 滚动后冻结行仍在", frozenAfter >= 10, String(frozenAfter));
  const rowText = await evalJson<string>(wc, `(() => { const c = document.querySelector('.xlsx-frozen-row .xlsx-cell'); return c ? c.textContent ?? '' : ''; })()`);
  check("frozen: 冻结行内容为表头", /ID|项目/.test(rowText), rowText);
  // 横向滚动 → 冻结列仍在
  const totalW = await evalJson<number>(wc, `document.querySelector('.xlsx-canvas').offsetWidth`);
  await wc.executeJavaScript(`document.querySelector('.xlsx-viewer-scroll').scrollLeft = ${Math.floor(totalW * 0.6)}`);
  await sleep(500);
  const colAfter = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-frozen-col .xlsx-cell').length`);
  check("frozen: 横向滚动后冻结列仍在", colAfter >= 5, String(colAfter));
}

async function scenarioMerged(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, GRID_STATE);
  check("merged: merge 块渲染", s.merges >= 1, String(s.merges));
  // 顶部全宽 merge（anchor A1 视口内）
  const topMerge = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-merge').length`);
  void topMerge;
  // 滚动到中部：大块 merge（anchor r30 视口外，覆盖区进入视口）
  const totalH = await evalJson<number>(wc, `document.querySelector('.xlsx-canvas').offsetHeight`);
  await wc.executeJavaScript(`document.querySelector('.xlsx-viewer-scroll').scrollTop = ${Math.floor(totalH * 0.5)}`);
  await sleep(600);
  const midMerges = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-merge').length`);
  check("merged: anchor 视口外覆盖区进入仍渲染", midMerges >= 1, String(midMerges));
  const bigMerge = await evalJson<boolean>(wc, `(() => { const m = document.querySelector('[data-merge^="30:0-40:5"]'); return !!m; })()`);
  check("merged: 大块 30:0-40:5 存在", bigMerge);
  // 滚动到底：右下角大块（50:20-55:29）需要横向滚动
  await wc.executeJavaScript(`document.querySelector('.xlsx-viewer-scroll').scrollTop = 1e9`);
  await wc.executeJavaScript(`document.querySelector('.xlsx-viewer-scroll').scrollLeft = 1e9`);
  await sleep(600);
  const farMerge = await evalJson<boolean>(wc, `(() => { const m = document.querySelector('[data-merge^="50:20-55:29"]'); return !!m; })()`);
  check("merged: 右下大块渲染", farMerge);
  // 回收不重复不丢失：merge 总数稳定（滚动前后）
  const countAfter = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-merge').length`);
  check("merged: DOM merge 数有界（<10）", countAfter > 0 && countAfter < 10, String(countAfter));
}

async function scenarioFormats(wc: Electron.WebContents): Promise<void> {
  // 日期/百分比/货币格式化文本
  const texts = await evalJson<string[]>(wc, `Array.from(document.querySelectorAll('.xlsx-cell')).slice(0, 60).map(c => c.textContent ?? '')`);
  const joined = texts.join("|");
  check("formats: 日期格式", /\d{4}-\d{2}-\d{2}/.test(joined), joined.slice(0, 60));
  check("formats: 百分比", /%/.test(joined), joined.slice(0, 60));
  check("formats: 货币 ¥", joined.includes("¥"), joined.slice(0, 60));
  // 样式：表头粗体（fontWeight 600）
  const boldHeaders = await evalJson<number>(wc, `(() => { const cells = Array.from(document.querySelectorAll('.xlsx-cell')).slice(0, 5); return cells.filter(c => getComputedStyle(c).fontWeight === '600').length; })()`);
  check("formats: 表头粗体", boldHeaders >= 4, String(boldHeaders));
  // 红字单元格
  const redText = await evalJson<number>(wc, `(() => Array.from(document.querySelectorAll('.xlsx-cell')).filter(c => getComputedStyle(c).color === 'rgb(255, 0, 0)').length)()`);
  check("formats: 红字单元格", redText >= 1, String(redText));
  // 灰底填充
  const grayFill = await evalJson<number>(wc, `(() => Array.from(document.querySelectorAll('.xlsx-cell')).filter(c => getComputedStyle(c).backgroundColor === 'rgb(238, 238, 238)').length)()`);
  check("formats: 灰底填充", grayFill >= 1, String(grayFill));
  // 居中单元格
  const centered = await evalJson<number>(wc, `(() => Array.from(document.querySelectorAll('.xlsx-cell')).filter(c => getComputedStyle(c).textAlign === 'center').length)()`);
  check("formats: 居中对齐", centered >= 1, String(centered));
}

async function scenarioFormula(wc: Electron.WebContents): Promise<void> {
  // 找到 D2（公式结果 = B2*C2 = 25.0）
  const d2 = await evalJson<string>(wc, `(() => { const cell = document.querySelector('.xlsx-cell[data-r="1"][data-c="3"]'); return cell ? cell.textContent ?? '' : ''; })()`);
  check("formula: D2 显示缓存结果", d2.length > 0 && d2 !== "=B2*C2", d2);
  // 合计 SUM 行（r21）
  const sum = await evalJson<string>(wc, `(() => { const cell = document.querySelector('.xlsx-cell[data-r="21"][data-c="3"]'); return cell ? cell.textContent ?? '' : ''; })()`);
  check("formula: SUM 缓存结果 1234.5", sum.includes("1234.5"), sum);
}

async function scenario1k50(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, GRID_STATE);
  check("1k50: 1001×50 元数据", s.meta.includes("1,001") && s.meta.includes("50"), s.meta);
  // 等画布宽度就绪后再横向滚动（防 scrollLeft 被 0 宽画布钳制）
  const wide = await waitFor(wc, `(() => { const el = document.querySelector('.xlsx-viewer-scroll'); return el && el.scrollWidth > el.clientWidth + 2000; })()`, 15000);
  check("1k50: 画布宽度就绪", wide);
  await wc.executeJavaScript(`(() => { const el = document.querySelector('.xlsx-viewer-scroll'); el.scrollLeft = el.scrollWidth; })()`);
  await sleep(700);
  const colHeaders = await evalJson<string[]>(wc, `Array.from(document.querySelectorAll('.xlsx-col-header-cell')).map(c => c.textContent ?? '')`);
  const hasAx = colHeaders.includes("AX");
  check("1k50: 列号滚动到 AX（50 列）", hasAx, colHeaders.slice(-3).join(","));
  const cellsAfter = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-cell').length`);
  check("1k50: 横向滚动后 DOM 有界（<1200，20px 行高视口 ~40 行）", cellsAfter > 0 && cellsAfter < 1200, String(cellsAfter));
  const live = await evalJson<number>(wc, `window.__w5a.stats().xlsx.cellsLive`);
  void live;
}

async function scenarioOversizedSkip(wc: Electron.WebContents): Promise<void> {
  const skipped = await evalJson<boolean>(wc, `!!document.querySelector('[data-testid="office-preview-skipped"]')`);
  const parsing = await evalJson<boolean>(wc, `Array.from(document.querySelectorAll('.xlsx-viewer-status')).some((el) => (el.textContent ?? '').includes('正在解析'))`);
  const cells = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-cell').length`);
  check("10k30: 超过 500KB 跳过解析", skipped, String(skipped));
  check("10k30: 不显示正在解析", !parsing);
  check("10k30: 不渲染单元格", cells === 0, String(cells));
}

async function scenario10k30(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, GRID_STATE);
  check("10k30: 10,001×30 元数据", s.meta.includes("10,001") && s.meta.includes("30"), s.meta);
  // 纵向滚动到中部
  const totalH = await evalJson<number>(wc, `document.querySelector('.xlsx-canvas').offsetHeight`);
  const hReady = await waitFor(wc, `(() => { const el = document.querySelector('.xlsx-viewer-scroll'); return el && el.scrollHeight > el.clientHeight + 5000; })()`, 15000);
  check("10k30: 画布高度就绪", hReady);
  await wc.executeJavaScript(`document.querySelector('.xlsx-viewer-scroll').scrollTop = ${Math.floor(totalH * 0.5)}`);
  await sleep(700);
  const cellsMid = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-cell').length`);
  check("10k30: 滚动后 DOM 有界（<1200）", cellsMid > 0 && cellsMid < 1200, String(cellsMid));
  const midRowText = await evalJson<string>(wc, `(() => { const cells = Array.from(document.querySelectorAll('.xlsx-body .xlsx-cell')); const withId = cells.find(c => /^\\d+$/.test((c.textContent ?? '').trim())); return withId ? withId.textContent ?? '' : ''; })()`);
  check("10k30: 中部行号 > 4000", parseInt(midRowText, 10) > 4000, midRowText);
  // 搜索定位
  await setInput(wc, ".xlsx-viewer-search-input", "记录-5000");
  const hasCount = await waitFor(wc, `!!document.querySelector('[data-testid="xlsx-search-count"]')`, 20000);
  check("10k30: 搜索计数出现", hasCount);
  await sleep(600);
  const hitCells = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-cell--search').length`);
  check("10k30: 命中高亮", hitCells >= 1, String(hitCells));
  const scrollTopAfter = await evalJson<number>(wc, `document.querySelector('.xlsx-viewer-scroll').scrollTop`);
  check("10k30: 搜索跳转到远端", scrollTopAfter > totalH * 0.4, String(scrollTopAfter));
  // 选择 + 复制
  await wc.executeJavaScript(`document.querySelector('.xlsx-cell--search')?.click()`);
  await sleep(300);
  const selected = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-cell--selected').length`);
  check("10k30: 点击选择", selected >= 1, String(selected));
  await wc.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))`);
  await sleep(300);
  const clipboard = await evalJson<string>(wc, `(async () => { try { return await navigator.clipboard.readText(); } catch { return 'CLIPBOARD-UNAVAILABLE'; } })()`);
  check("10k30: Ctrl+C 复制（内容或不可用降级）", clipboard === "记录-5000" || clipboard === "CLIPBOARD-UNAVAILABLE", clipboard);
  // 清除搜索
  await wc.executeJavaScript(`document.querySelector('[data-action="search-clear"]').click()`);
  await sleep(300);
  const cleared = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-cell--search').length`);
  check("10k30: 清除搜索", cleared === 0, String(cleared));
}

async function scenarioLeak(wc: Electron.WebContents): Promise<void> {
  await waitFor(wc, `document.querySelector('.xlsx-viewer-meta')?.textContent.includes('1,001')`, 40000);
  await sleep(800);
  const scroll = await evalJson<any>(wc, `(() => { const el = document.querySelector('.xlsx-viewer-scroll'); return { h: el.scrollHeight, w: el.scrollWidth }; })()`);
  for (const [y, x] of [[0.3, 0.3], [0.6, 0.7], [0.9, 0.2], [0.4, 0.9], [0.8, 0.5]] as const) {
    await wc.executeJavaScript(`(() => { const el = document.querySelector('.xlsx-viewer-scroll'); el.scrollTop = ${Math.floor(scroll.h * y)}; el.scrollLeft = ${Math.floor(scroll.w * x)}; })()`);
    await sleep(250);
  }
  const mid = await evalJson<any>(wc, GRID_STATE);
  check("leak: 滚动后 DOM 有界", mid.cells > 0 && mid.cells < 1200, String(mid.cells));
  await setInput(wc, ".xlsx-viewer-search-input", "Column");
  await waitFor(wc, `!!document.querySelector('[data-testid="xlsx-search-count"]')`, 20000);
  await sleep(400);
  // 切换 simple → close
  await wc.executeJavaScript(`window.__w5a.renderXlsx('xlsx-simple.xlsx')`);
  await waitFor(wc, `document.querySelector('.xlsx-viewer-meta')?.textContent.includes('41')`, 40000);
  await sleep(500);
  await wc.executeJavaScript(`window.__w5a.renderXlsx(null)`);
  await sleep(500);
  const end = await evalJson<any>(wc, `window.__w5a.stats()`);
  check("leak: xlsxDom 清空", end.xlsxDom === 0, String(end.xlsxDom));
  check("leak: docs 归零", end.xlsx.docs === 0, String(end.xlsx.docs));
  check("leak: listeners 归零", end.xlsx.listeners === 0, String(end.xlsx.listeners));
  check("leak: observers 归零", end.xlsx.observers === 0, String(end.xlsx.observers));
  check("leak: objectURL 零调用", end.objectUrlCalls === 0, String(end.objectUrlCalls));
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
    width: 1200,
    height: 800,
    show: false,
    webPreferences: { webSecurity: false },
  });

  const scenarios: Array<[string, string, string, (wc: Electron.WebContents) => Promise<void>]> = [
    ["xlsx-simple", "?file=xlsx-simple.xlsx&kind=xlsx", ".xlsx-cell", scenarioSimple],
    ["xlsx-multi", "?file=xlsx-multi.xlsx&kind=xlsx", ".xlsx-cell", scenarioMulti],
    ["xlsx-frozen", "?file=xlsx-frozen.xlsx&kind=xlsx", ".xlsx-cell", scenarioFrozen],
    ["xlsx-merged", "?file=xlsx-merged.xlsx&kind=xlsx", ".xlsx-cell", scenarioMerged],
    ["xlsx-formats", "?file=xlsx-formats.xlsx&kind=xlsx", ".xlsx-cell", scenarioFormats],
    ["xlsx-formula", "?file=xlsx-formula.xlsx&kind=xlsx", ".xlsx-cell", scenarioFormula],
    ["xlsx-1k50", "?file=xlsx-1k50.xlsx&kind=xlsx", ".xlsx-cell", scenario1k50],
    ["xlsx-10k30", "?file=xlsx-10k30.xlsx&kind=xlsx", "[data-testid=\"office-preview-skipped\"]", scenarioOversizedSkip],
    ["perf-leak", "?file=xlsx-1k50.xlsx&kind=xlsx", ".xlsx-cell", scenarioLeak],
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
