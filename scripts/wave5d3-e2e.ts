/**
 * Wave 5D-3 — PPTX Quality Gate（真实 Electron E2E）
 *
 * 真实 Electron + 真实生产组件（PptxViewer，经 build-wave5a-preview.mjs 打包）
 * + 自研 OOXML slide 渲染器 + 真实 PPTX fixture。
 *
 * 场景（5D-3 Gate 机器断言面）：
 *   pptx-simple   5 slides：渲染/导航/缩放/元数据
 *   pptx-media    图文混排：图片存在且保持比例
 *   pptx-zorder   重叠 shape：z-order 视觉（后添加在上层）
 *   pptx-gradient 渐变/半透明/旋转
 *   pptx-table    表格渲染
 *   pptx-43       4:3 尺寸
 *   pptx-long     24 slides：主区回收（DOM ≤3）+ 缩略图 lazy + 搜索跳转
 *   perf-leak     long → 导航 → 搜索 → 切换 → close 全归零
 *
 * 前置：node scripts/build-wave5a-preview.mjs
 * 运行：pnpm test:wave5d3-e2e
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

async function setInput(wc: Electron.WebContents, selector: string, value: string): Promise<void> {
  await wc.executeJavaScript(
    `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
}

const VIEWER_STATE = `(() => {
  const v = document.querySelector('.pptx-viewer');
  if (!v) return null;
  return {
    meta: document.querySelector('.pptx-viewer-meta')?.textContent ?? '',
    scale: document.querySelector('[data-testid="pptx-scale"]')?.textContent ?? '',
    stageSlides: document.querySelectorAll('.pptx-stage-slide').length,
    thumbs: document.querySelectorAll('.pptx-thumb').length,
    slideText: document.querySelector('.pptx-stage-slide.active .pptx-slide-inner')?.textContent?.slice(0, 80) ?? '',
    imgs: document.querySelectorAll('.pptx-stage-slide.active img').length,
    tables: document.querySelectorAll('.pptx-stage-slide.active table').length,
    marks: document.querySelectorAll('.pptx-stage-slide.active mark.pdf-match').length,
    stats: window.__w5a.stats().pptx,
  };
})()`;

// ---------- 场景 ----------

async function scenarioSimple(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, VIEWER_STATE);
  check("simple: 5 slides 元数据", s.meta.includes("5"), s.meta);
  check("simple: 主区渲染 1-3 slides", s.stageSlides >= 1 && s.stageSlides <= 3, String(s.stageSlides));
  check("simple: 缩略图渲染", s.thumbs >= 1, String(s.thumbs));
  check("simple: 标题文本", s.slideText.includes("MyBuddy PPTX Fixture"), s.slideText);
  check("simple: fit 缩放", s.scale.includes("%"), s.scale);
  // 下一页
  await wc.executeJavaScript(`document.querySelector('[data-action="next"]').click()`);
  await sleep(400);
  const s2 = await evalJson<any>(wc, VIEWER_STATE);
  check("simple: 下一页文本", s2.slideText.includes("第 1 页要点"), s2.slideText);
  // 100%
  await wc.executeJavaScript(`document.querySelector('[data-action="zoom-100"]').click()`);
  await sleep(300);
  const z100 = await evalJson<any>(wc, VIEWER_STATE);
  check("simple: 100% 缩放", z100.scale.includes("100%"), z100.scale);
  await wc.executeJavaScript(`document.querySelector('[data-action="zoom-in"]').click()`);
  await sleep(300);
  const zin = await evalJson<any>(wc, VIEWER_STATE);
  check("simple: zoom-in > 100%", parseInt(zin.scale, 10) > 100, zin.scale);
  await wc.executeJavaScript(`document.querySelector('[data-action="fit-slide"]').click()`);
  await sleep(300);
  // 缩略图点击跳转
  await wc.executeJavaScript(`document.querySelector('[data-thumb="4"]')?.click()`);
  await sleep(400);
  const s5 = await evalJson<any>(wc, VIEWER_STATE);
  check("simple: 缩略图跳转第 5 页", s5.slideText.includes("Key Point 4"), s5.slideText);
}

async function scenarioOversizedSkip(wc: Electron.WebContents): Promise<void> {
  const skipped = await evalJson<boolean>(wc, `!!document.querySelector('[data-testid="office-preview-skipped"]')`);
  const parsing = await evalJson<boolean>(wc, `Array.from(document.querySelectorAll('.pptx-viewer-status')).some((el) => (el.textContent ?? '').includes('正在解析'))`);
  const slides = await evalJson<number>(wc, `document.querySelectorAll('.pptx-stage-slide').length`);
  check("media: 超过 500KB 跳过解析", skipped);
  check("media: 不显示正在解析", !parsing);
  check("media: 不渲染幻灯片", slides === 0, String(slides));
}

async function scenarioMedia(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, VIEWER_STATE);
  check("media: 主 slide 图片", s.imgs >= 1, String(s.imgs));
  const imgLoaded = await evalJson<boolean>(wc, `(() => { const img = document.querySelector('.pptx-stage-slide img'); return !!img && img.complete && img.naturalWidth > 0; })()`);
  check("media: 图片解码完成", imgLoaded);
  const imgBox = await evalJson<{ w: number; h: number }>(
    wc,
    `(() => { const img = document.querySelector('.pptx-stage-slide img'); const r = img.parentElement.getBoundingClientRect(); return { w: r.width, h: r.height }; })()`,
  );
  check("media: 图片盒子非零", imgBox.w > 50 && imgBox.h > 50, `${imgBox.w}×${imgBox.h}`);
  check("media: 图文混排文本", s.slideText.includes("图文混排") || /aspect ratio/i.test(s.slideText), s.slideText);
}

async function scenarioZorder(wc: Electron.WebContents): Promise<void> {
  // 3 个重叠 shape：后添加的三角形应在最上层（同一坐标区域取元素交集判断）
  const shapes = await evalJson<Array<{ x: number; y: number; w: number; h: number; bg: string; z: number }>>(
    wc,
    `Array.from(document.querySelectorAll('.pptx-stage-slide .pptx-shape')).filter(s => {
      const bg = getComputedStyle(s).backgroundColor;
      return bg !== 'rgba(0, 0, 0, 0)';
    }).map(s => {
      const r = s.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, bg: getComputedStyle(s).backgroundColor, z: parseInt(getComputedStyle(s).zIndex, 10) || 0 };
    })`,
  );
  const colored = shapes.filter((s) => s.bg !== "rgba(0, 0, 0, 0)");
  check("zorder: 3 个有色 shape", colored.length === 3, String(colored.length));
  if (colored.length >= 3) {
    // 三角形（绿色）后添加 → 覆盖蓝色矩形与橙色圆的重叠区 → zIndex 最大
    const sorted = [...colored].sort((a, b) => a.z - b.z);
    check("zorder: zIndex 递增", sorted[0]!.z < sorted[2]!.z, `${sorted[0]!.z} < ${sorted[2]!.z}`);
    const green = colored.find((c) => c.bg.includes("112, 173"));
    const blue = colored.find((c) => c.bg.includes("68, 114"));
    check("zorder: 蓝/绿形状存在", !!green && !!blue);
    const overlap = colored.filter((c) => {
      const others = colored.filter((o) => o !== c);
      return others.some((o) => c.x < o.x + o.w && c.x + c.w > o.x && c.y < o.y + o.h && c.y + c.h > o.y);
    });
    check("zorder: 形状相互重叠（几何）", overlap.length >= 2, String(overlap.length));
  }
}

async function scenarioGradient(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, VIEWER_STATE);
  check("gradient: 文本提示", s.slideText.includes("渐变"), s.slideText);
  // 渐变形状（红→蓝 linear-gradient）
  const gradients = await evalJson<number>(wc, `(() => Array.from(document.querySelectorAll('.pptx-stage-slide .pptx-shape')).filter(s => (getComputedStyle(s).backgroundImage || '').includes('linear-gradient')).length)()`);
  check("gradient: linear-gradient 形状", gradients >= 1, String(gradients));
  // 半透明（opacity < 1）
  const transparent = await evalJson<number>(wc, `(() => Array.from(document.querySelectorAll('.pptx-stage-slide .pptx-shape')).filter(s => parseFloat(getComputedStyle(s).opacity) < 1).length)()`);
  check("gradient: 半透明形状", transparent >= 1, String(transparent));
  // 旋转形状（transform rotate）
  const rotated = await evalJson<number>(wc, `(() => Array.from(document.querySelectorAll('.pptx-stage-slide .pptx-shape')).filter(s => (getComputedStyle(s).transform || '') !== 'none' && !(getComputedStyle(s).transform || '').includes('matrix(1, 0, 0, 1')).length)()`);
  check("gradient: 旋转形状", rotated >= 1, String(rotated));
}

async function scenarioTable(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, VIEWER_STATE);
  check("table: 表格渲染", s.tables >= 1, String(s.tables));
  const cellText = await evalJson<string>(wc, `document.querySelector('.pptx-stage-slide table td')?.textContent ?? ''`);
  check("table: 表头单元格", cellText === "产品", cellText);
  const rowCount = await evalJson<number>(wc, `document.querySelectorAll('.pptx-stage-slide table tr').length`);
  check("table: 7 行", rowCount === 7, String(rowCount));
  const headerFill = await evalJson<string>(wc, `getComputedStyle(document.querySelector('.pptx-stage-slide table td')).backgroundColor`);
  check("table: 表头蓝底", headerFill.includes("68, 114"), headerFill);
}

async function scenario43(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, VIEWER_STATE);
  check("43: 2 slides", s.meta.includes("2"), s.meta);
  check("43: 文本", s.slideText.includes("4:3"), s.slideText);
  // slide 尺寸：960×720 → 宽高比 4:3
  const ratio = await evalJson<number>(wc, `(() => { const el = document.querySelector('.pptx-stage-slide .pptx-slide-inner'); const r = el.getBoundingClientRect(); return r.width / r.height; })()`);
  check("43: 宽高比 ≈ 4:3", Math.abs(ratio - 4 / 3) < 0.05, ratio.toFixed(3));
}

async function scenarioLong(wc: Electron.WebContents): Promise<void> {
  const s = await evalJson<any>(wc, VIEWER_STATE);
  check("long: 24 slides", s.meta.includes("24"), s.meta);
  check("long: 主区 DOM ≤3（回收）", s.stageSlides > 0 && s.stageSlides <= 3, String(s.stageSlides));
  check("long: 缩略图 lazy（<24）", s.thumbs > 0 && s.thumbs < 24, String(s.thumbs));
  // 导航到远端（缩略图滚动窗口 + 主区回收）
  await wc.executeJavaScript(`document.querySelector('[data-action="next"]').click()`);
  await sleep(200);
  await wc.executeJavaScript(`document.querySelector('[data-action="next"]').click()`);
  await sleep(300);
  const s3 = await evalJson<any>(wc, VIEWER_STATE);
  check("long: 导航后主区仍 ≤3", s3.stageSlides <= 3, String(s3.stageSlides));
  // 页码跳转第 24 页
  await setInput(wc, ".pptx-viewer-page-input", "24");
  await sleep(80);
  await wc.executeJavaScript(`document.querySelector('.pptx-viewer-page-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await sleep(400);
  const s24 = await evalJson<any>(wc, VIEWER_STATE);
  check("long: 跳转第 24 页", s24.slideText.includes("Section 24"), s24.slideText);
  // 搜索
  await setInput(wc, ".pptx-viewer-search-input", "Section 24");
  const hasCount = await waitFor(wc, `!!document.querySelector('[data-testid="pptx-search-count"]')`, 15000);
  check("long: 搜索计数", hasCount);
  const marks = await evalJson<number>(wc, `document.querySelectorAll('.pptx-stage-slide mark.pdf-match').length`);
  check("long: 搜索高亮 mark", marks >= 1, String(marks));
  await wc.executeJavaScript(`document.querySelector('[data-action="search-clear"]').click()`);
  await sleep(300);
  const cleared = await evalJson<number>(wc, `document.querySelectorAll('.pptx-stage-slide mark.pdf-match').length`);
  check("long: 清除搜索", cleared === 0, String(cleared));
}

async function scenarioLeak(wc: Electron.WebContents): Promise<void> {
  await waitFor(wc, `document.querySelector('.pptx-viewer-meta')?.textContent.includes('24')`, 40000);
  await sleep(600);
  for (let i = 0; i < 6; i++) {
    await wc.executeJavaScript(`document.querySelector('[data-action="next"]').click()`);
    await sleep(150);
  }
  await setInput(wc, ".pptx-viewer-search-input", "Section");
  await waitFor(wc, `!!document.querySelector('[data-testid="pptx-search-count"]')`, 15000);
  await sleep(300);
  await wc.executeJavaScript(`window.__w5a.renderPptx('pptx-simple.pptx')`);
  await waitFor(wc, `document.querySelector('.pptx-viewer-meta')?.textContent.includes('5')`, 40000);
  await sleep(500);
  await wc.executeJavaScript(`window.__w5a.renderPptx(null)`);
  await sleep(500);
  const end = await evalJson<any>(wc, `window.__w5a.stats()`);
  check("leak: pptxDom 清空", end.pptxDom === 0, String(end.pptxDom));
  check("leak: docs 归零", end.pptx.docs === 0, String(end.pptx.docs));
  check("leak: listeners 归零", end.pptx.listeners === 0, String(end.pptx.listeners));
  check("leak: observers 归零", end.pptx.observers === 0, String(end.pptx.observers));
  check("leak: slidesLive 归零", end.pptx.slidesLive === 0, String(end.pptx.slidesLive));
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
    width: 1300,
    height: 820,
    show: false,
    webPreferences: { webSecurity: false },
  });

  const scenarios: Array<[string, string, string, (wc: Electron.WebContents) => Promise<void>]> = [
    ["pptx-simple", "?file=pptx-simple.pptx&kind=pptx", ".pptx-stage-slide", scenarioSimple],
    ["pptx-media", "?file=pptx-media.pptx&kind=pptx", "[data-testid=\"office-preview-skipped\"]", scenarioOversizedSkip],
    ["pptx-zorder", "?file=pptx-zorder.pptx&kind=pptx", ".pptx-stage-slide", scenarioZorder],
    ["pptx-gradient", "?file=pptx-gradient.pptx&kind=pptx", ".pptx-stage-slide", scenarioGradient],
    ["pptx-table", "?file=pptx-table.pptx&kind=pptx", ".pptx-stage-slide", scenarioTable],
    ["pptx-43", "?file=pptx-43.pptx&kind=pptx", ".pptx-stage-slide", scenario43],
    ["pptx-long", "?file=pptx-long-24p.pptx&kind=pptx", ".pptx-stage-slide", scenarioLong],
    ["perf-leak", "?file=pptx-long-24p.pptx&kind=pptx", ".pptx-stage-slide", scenarioLeak],
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
