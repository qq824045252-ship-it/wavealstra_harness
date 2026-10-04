/**
 * Wave 5A — Markdown + Code 质量 Gate（真实 Electron E2E）
 *
 * 真实 Electron + 真实生产组件（CodeView / MarkdownArtifactView，经
 * build-wave5a-preview.mjs 打包）+ 真实 Shiki/Monaco → 页面内 DOM 断言。
 *
 * 场景（5A Gate 机器断言面）：
 *   md-features  GFM 全要素（表格/任务列表/锚点/脚注/图片策略）
 *   md-long      虚拟化长文档（DOM 章节 < 总章节，估算高度 > 视口）
 *   code-ts/js/shell/json  各语言 Shiki token 断言
 *   code-large   10.9k 行虚拟行（DOM 行数 << 总行数）
 *   code-longline 超长行横向滚动（scrollWidth > clientWidth）
 *   code-edit    Monaco 编辑态挂载 + 退出 dispose
 *   theme-switch 双主题 token 颜色切换
 *
 * 前置：node scripts/build-wave5a-preview.mjs
 * 运行：pnpm test:wave5a-e2e（esbuild bundle → electron 主进程执行）
 */
import { app, BrowserWindow, protocol } from "electron";
import { join } from "node:path";

const ROOT = process.cwd();
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");
const PAGE =
  "file:///" + join(ROOT, "fixtures", "golden-pages", "wave5a-preview.html").replace(/\\/g, "/");

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(wc: Electron.WebContents, expr: string, timeout = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await wc.executeJavaScript(expr)) return true;
    } catch {
      /* page mid-load */
    }
    await sleep(150);
  }
  console.log(`  [waitFor] 超时: ${expr.slice(0, 80)}`);
  return false;
}

async function evalJson<T>(wc: Electron.WebContents, expr: string): Promise<T> {
  return (await wc.executeJavaScript(`(${expr})`)) as T;
}

// ---------- 场景 ----------

async function scenarioMdFeatures(wc: Electron.WebContents): Promise<void> {
  const sections = await evalJson<number>(wc, `document.querySelectorAll('.md-section').length`);
  check("md: 章节渲染", sections >= 1, `${sections} sections`);
  const tables = await evalJson<number>(wc, `document.querySelectorAll('.md-doc table').length`);
  check("md: 表格渲染", tables >= 1, `${tables} tables`);
  const rows = await evalJson<number>(wc, `document.querySelectorAll('.md-doc table tr').length`);
  check("md: 表格 ≥4 行", rows >= 5, `${rows} rows`);
  const checkboxes = await evalJson<number>(
    wc,
    `document.querySelectorAll('.md-doc input[type=checkbox]').length`,
  );
  check("md: 任务列表 checkbox ≥4", checkboxes >= 4, `${checkboxes} checkboxes`);
  const h1 = await evalJson<boolean>(wc, `!!document.getElementById('markdown-功能覆盖样本')`);
  check("md: 章节标题锚点 id", h1);
  const footnotes = await evalJson<boolean>(
    wc,
    `document.body.innerText.includes('脚注一：正文引用后集中定义')`,
  );
  check("md: 脚注渲染（GFM）", footnotes);
  const taskText = await evalJson<boolean>(wc, `document.body.innerText.includes('已完成：Shiki 静态高亮集成')`);
  check("md: 任务列表文本", taskText);
  // 图片策略在文档尾部（视口外）→ 滚动触发虚拟渲染（测量收敛需多轮，顶部章节会卸载，故先断言任务列表）
  await wc.executeJavaScript(
    `(() => { const v = document.querySelector('.md-doc-viewer'); if (v) v.scrollTop = v.scrollHeight; return true; })()`,
  );
  await sleep(500);
  await wc.executeJavaScript(
    `(() => { const v = document.querySelector('.md-doc-viewer'); if (v) v.scrollTop = v.scrollHeight; return true; })()`,
  );
  await sleep(800);
  const placeholder = await evalJson<number>(wc, `document.querySelectorAll('.md-img-placeholder').length`);
  check("md: 相对路径图片占位", placeholder >= 1, `${placeholder}`);
  const dataImg = await evalJson<number>(
    wc,
    `document.querySelectorAll('.md-img[src^="data:"]').length`,
  );
  check("md: data-URI 图片渲染", dataImg >= 1, `${dataImg}`);
}

async function scenarioMdLong(wc: Electron.WebContents): Promise<void> {
  const sections = await evalJson<number>(wc, `document.querySelectorAll('.md-section').length`);
  check("md-long: 视口内章节 >0", sections > 0, `${sections}`);
  check("md-long: 虚拟化（DOM 章节 < 30，fixture 40+ 章）", sections < 30, `${sections} in DOM`);
  const innerHeight = await evalJson<number>(
    wc,
    `parseInt(document.querySelector('.md-doc-viewer-inner')?.style.height ?? '0', 10)`,
  );
  check("md-long: 虚拟总高度 > 5000px", innerHeight > 5000, `${innerHeight}px`);
  const heading = await evalJson<boolean>(
    wc,
    `!!document.querySelector('.md-section-heading') && document.querySelector('.md-section-heading')?.textContent.includes('长文档性能基准样本')`,
  );
  check("md-long: 首章节标题", heading);
  const toc = await evalJson<boolean>(wc, `document.body.innerText.includes('目录')`);
  check("md-long: 目录渲染", toc);
  // 锚点跳转：点击目录第一个链接 → 目标标题存在（跨章节滚动由组件处理）
  const anchorClick = await evalJson<boolean>(
    wc,
    `(() => { const a = document.querySelector('a[href^="#"]'); if (!a) return false; a.click(); return true; })()`,
  );
  check("md-long: 锚点链接可点击", anchorClick);
}

async function scenarioCode(
  wc: Electron.WebContents,
  label: string,
  lang: string,
  expectBadge: string,
  expectMinSpans = 20,
): Promise<void> {
  const spans = await evalJson<number>(
    wc,
    `document.querySelectorAll('.shiki-line span[style]').length`,
  );
  check(`code-${label}: Shiki token span ≥${expectMinSpans}`, spans >= expectMinSpans, `${spans} spans`);
  const badge = await evalJson<string>(wc, `document.querySelector('.code-view-badge')?.textContent ?? ''`);
  check(`code-${label}: 语言徽章 ${expectBadge}`, badge === expectBadge, badge);
  const copyBtn = await evalJson<boolean>(wc, `!!document.querySelector('[data-action="copy"]')`);
  check(`code-${label}: 复制按钮`, copyBtn);
  const lineNo = await evalJson<number>(wc, `document.querySelectorAll('.code-lineno').length`);
  check(`code-${label}: 行号渲染`, lineNo > 0, `${lineNo}`);
  void lang;
}

async function scenarioCodeLarge(wc: Electron.WebContents): Promise<void> {
  const rows = await evalJson<number>(wc, `document.querySelectorAll('.code-view-virtual-row').length`);
  check("code-large: 虚拟行 DOM 数 < 300（10.9k 行）", rows > 0 && rows < 300, `${rows} rows`);
  const totalHeight = await evalJson<number>(
    wc,
    `parseInt(document.querySelector('.code-view-virtual-inner')?.style.height ?? '0', 10)`,
  );
  check("code-large: 虚拟总高度 > 150000px", totalHeight > 150000, `${totalHeight}px`);
  const stats = await evalJson<string>(wc, `document.querySelector('.code-view-stats')?.textContent ?? ''`);
  check("code-large: 行数统计 10,920（尾部换行归一）", stats.includes("10,920"), stats);
}

async function scenarioCodeLongline(wc: Electron.WebContents): Promise<void> {
  const scroll = await evalJson<{ sw: number; cw: number }>(
    wc,
    `(() => { const r = document.getElementById('root'); return { sw: r.scrollWidth, cw: r.clientWidth }; })()`,
  );
  check("longline: 横向滚动（scrollWidth > clientWidth）", scroll.sw > scroll.cw, `${scroll.sw} > ${scroll.cw}`);
  const spans = await evalJson<number>(
    wc,
    `document.querySelectorAll('.shiki-line span[style]').length`,
  );
  check("longline: 超长行高亮", spans > 5, `${spans}`);
}

async function scenarioThemeSwitch(wc: Electron.WebContents): Promise<void> {
  const htmlOf = (sel: string): Promise<string> =>
    evalJson<string>(wc, `document.querySelector(${JSON.stringify(sel)})?.innerHTML ?? ''`);
  const before = await htmlOf(".code-view-body, .code-view-virtual-inner");
  await wc.executeJavaScript(`window.__w5a.setTheme('dark')`);
  await sleep(500);
  const after = await htmlOf(".code-view-body, .code-view-virtual-inner");
  check(
    "theme: 切换后 token 颜色变化（整树 HTML 差异）",
    before.length > 0 && after.length > 0 && before !== after,
    `len ${before.length} → ${after.length}`,
  );
  const darkAttr = await evalJson<string>(wc, `document.documentElement.dataset.theme ?? ''`);
  check("theme: data-theme=dark", darkAttr === "dark", darkAttr);
  await wc.executeJavaScript(`window.__w5a.setTheme('light')`);
  await sleep(200);
}

async function scenarioCodeEdit(wc: Electron.WebContents): Promise<void> {
  const clicked = await evalJson<boolean>(
    wc,
    `(() => { const b = document.querySelector('[data-action="edit"]'); if (!b) return false; b.click(); return true; })()`,
  );
  check("edit: 点击编辑按钮", clicked);
  const mounted = await waitFor(wc, `!!document.querySelector('.monaco-editor')`, 30000);
  check("edit: Monaco 挂载（lazy load）", mounted);
  const badge = await evalJson<string>(wc, `document.querySelector('.code-view-badge')?.textContent ?? ''`);
  check("edit: Monaco 工具栏徽章", badge === "Monaco", badge);
  const exited = await evalJson<boolean>(
    wc,
    `(() => { const b = document.querySelector('[data-action="exit-edit"]'); if (!b) return false; b.click(); return true; })()`,
  );
  check("edit: 点击退出编辑", exited);
  const disposed = await waitFor(wc, `!document.querySelector('.monaco-editor')`, 10000);
  check("edit: dispose 后 Monaco 卸载", disposed);
  const containerGone = await evalJson<boolean>(
    wc,
    `!document.querySelector('.code-view-edit-container')`,
  );
  check("edit: 编辑容器释放", containerGone);
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
    width: 1000,
    height: 760,
    show: false,
    webPreferences: { webSecurity: false },
  });

  const scenarios: Array<[string, string, string, (wc: Electron.WebContents) => Promise<void>]> = [
    ["md-features", "?file=markdown-features.md&kind=markdown", ".md-section", scenarioMdFeatures],
    ["md-long", "?file=markdown-long.md&kind=markdown", ".md-section", scenarioMdLong],
    ["code-ts", "?file=code-ts.ts&lang=typescript", ".shiki-line span", (wc) => scenarioCode(wc, "ts", "typescript", "typescript")],
    ["code-js", "?file=code-js.js&lang=javascript", ".shiki-line span", (wc) => scenarioCode(wc, "js", "javascript", "javascript")],
    ["code-shell", "?file=code-shell.sh&lang=shell", ".shiki-line span", (wc) => scenarioCode(wc, "shell", "shell", "shell")],
    ["code-json", "?file=code-json.json&lang=json", ".shiki-line span", (wc) => scenarioCode(wc, "json", "json", "json")],
    ["code-large", "?file=code-large.ts&lang=typescript", ".code-view-virtual-row", scenarioCodeLarge],
    ["code-longline", "?file=code-longline.ts&lang=typescript", ".shiki-line span", scenarioCodeLongline],
    ["theme-switch", "?file=code-ts.ts&lang=typescript", ".shiki-line span", scenarioThemeSwitch],
    ["code-edit", "?file=code-medium.ts&lang=typescript", ".shiki-line span", scenarioCodeEdit],
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
      // 高亮/虚拟化稳定
      await sleep(1200);
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
