/**
 * Wave 5B — Image Quality Gate（真实 Electron E2E）
 *
 * 真实 Electron + 真实生产组件（ImageArtifactView，经 build-wave5a-preview.mjs
 * 打包）+ 真实图片 fixture（8K/透明/EXIF/超宽/小图）→ 页面内 DOM/交互断言。
 *
 * 场景（5B Gate 机器断言面）：
 *   img-basic      fit-to-window 首帧（等比、不溢出）+ 元数据面板
 *   img-transparent 棋盘格（png alpha）
 *   img-exif       浏览器方向矫正（横图 Orientation=6 → 竖显）
 *   img-small      小图上采样放大（fit scale > 1）
 *   img-8k         8K 加载 + 100% + 拖拽 pan（钳制）+ Ctrl+滚轮（锚点保持）+ 双击切换 + reset
 *   img-wide       fit-width 宽度适配 + 垂直 pan
 *   leak           8K → 4K → 8K → unmount：实例/监听器/observer/objectURL 全归零
 *
 * 前置：node scripts/build-wave5a-preview.mjs
 * 运行：pnpm test:wave5b-e2e（esbuild bundle → electron 主进程执行）
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

/** 读取图片元素当前变换（translate + 显示尺寸） */
const IMG_STATE = `(() => {
  const img = document.querySelector('.image-viewer-img');
  if (!img) return null;
  const m = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/.exec(img.style.transform || '');
  return {
    w: img.style.width, h: img.style.height,
    panX: m ? parseFloat(m[1]) : 0, panY: m ? parseFloat(m[2]) : 0,
    naturalW: img.naturalWidth, naturalH: img.naturalHeight,
    scaleText: document.querySelector('[data-testid="image-scale"]')?.textContent ?? '',
  };
})()`;

// ---------- 场景 ----------

async function scenarioBasic(wc: Electron.WebContents): Promise<void> {
  const stage = await evalJson<{ w: number; h: number }>(
    wc,
    `(() => { const s = document.querySelector('[data-testid="image-stage"]'); return { w: s.clientWidth, h: s.clientHeight }; })()`,
  );
  const img = await evalJson<any>(wc, IMG_STATE);
  check("basic: 解码完成 1024×768", img.naturalW === 1024 && img.naturalH === 768, `${img.naturalW}×${img.naturalH}`);
  const dw = parseFloat(img.w);
  const dh = parseFloat(img.h);
  check("basic: fit 等比不溢出", dw <= stage.w + 1 && dh <= stage.h + 1, `${dw}×${dh} ≤ ${stage.w}×${stage.h}`);
  check("basic: 宽高比保持", Math.abs(dw / dh - 1024 / 768) < 0.01, (dw / dh).toFixed(3));
  check("basic: fit 缩放 < 100%", img.scaleText.endsWith("%") && parseInt(img.scaleText, 10) < 100, img.scaleText);
  const meta = await evalJson<string>(wc, `document.querySelector('.image-viewer-meta')?.textContent ?? ''`);
  check("basic: 元数据 1024 × 768 + PNG", meta.includes("1024 × 768") && meta.includes("PNG"), meta);
}

async function scenarioTransparent(wc: Electron.WebContents): Promise<void> {
  const alpha = await evalJson<boolean>(wc, `!!document.querySelector('.image-viewer-img--alpha')`);
  check("transparent: 棋盘格 class（png）", alpha);
}

async function scenarioExif(wc: Electron.WebContents): Promise<void> {
  const img = await evalJson<any>(wc, IMG_STATE);
  // 文件原始 600×400（横），Orientation=6 → 浏览器显示 400×600（竖）
  check("exif: 方向矫正后竖显（w<h）", img.naturalW < img.naturalH, `${img.naturalW}×${img.naturalH}`);
  check("exif: 矫正尺寸 400×600", img.naturalW === 400 && img.naturalH === 600, `${img.naturalW}×${img.naturalH}`);
}

async function scenarioSmall(wc: Electron.WebContents): Promise<void> {
  const img = await evalJson<any>(wc, IMG_STATE);
  check("small: 2×2 解码", img.naturalW === 2 && img.naturalH === 2);
  const pct = parseInt(img.scaleText, 10);
  check("small: fit 上采样 > 100%", pct > 100, img.scaleText);
}

async function scenario8k(wc: Electron.WebContents): Promise<void> {
  const img = await evalJson<any>(wc, IMG_STATE);
  check("8k: 7680×4320 解码", img.naturalW === 7680 && img.naturalH === 4320);
  const fitPct = parseInt(img.scaleText, 10);
  check("8k: fit < 20%", fitPct < 20, img.scaleText);
  const degrade = await evalJson<boolean>(wc, `!!document.querySelector('.image-viewer-degrade')`);
  check("8k: 33MP 不触发超大图降级", !degrade);

  // 100%
  await wc.executeJavaScript(`document.querySelector('[data-action="zoom-100"]').click()`);
  await sleep(200);
  const z100 = await evalJson<any>(wc, IMG_STATE);
  check("8k: 100% 显示 = 自然尺寸", Math.abs(parseFloat(z100.w) - 7680) < 1 && Math.abs(parseFloat(z100.h) - 4320) < 1, `${z100.w}×${z100.h}`);
  check("8k: 100% 缩放文本", z100.scaleText.includes("100%"), z100.scaleText);

  // 拖拽 pan（钳制）：fit 态已居中，向上拖（负 delta）离开边界
  const before = await evalJson<any>(wc, IMG_STATE);
  await wc.executeJavaScript(
    `(() => {
      const s = document.querySelector('[data-testid="image-stage"]');
      const r = s.getBoundingClientRect();
      const fire = (t, x, y) => s.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      fire('mousedown', r.left + 300, r.top + 200);
      fire('mousemove', r.left + 400, r.top + 60);
      fire('mouseup', r.left + 400, r.top + 60);
      return true;
    })()`,
  );
  await sleep(150);
  const after = await evalJson<any>(wc, IMG_STATE);
  check("8k: 拖拽改变 pan", Math.abs(after.panX - before.panX) > 50 || Math.abs(after.panY - before.panY) > 50, `(${before.panX},${before.panY}) → (${after.panX},${after.panY})`);
  const maxPanX = 1000 - 7680; // 视口 1000 宽
  check(
    "8k: pan 钳制在 [viewport-disp, 0]",
    after.panX >= maxPanX - 1 && after.panX <= 0.5,
    `panX=${after.panX} min=${maxPanX}`,
  );

  // Ctrl+滚轮缩放（围绕光标）
  const wheelState = await evalJson<any>(
    wc,
    `(() => {
      const s = document.querySelector('[data-testid="image-stage"]');
      const r = s.getBoundingClientRect();
      const img = document.querySelector('.image-viewer-img');
      const m = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/.exec(img.style.transform || '');
      const scale = parseFloat(img.style.width) / img.naturalWidth;
      const panX = m ? parseFloat(m[1]) : 0;
      const panY = m ? parseFloat(m[2]) : 0;
      const ax = 300, ay = 200;
      const px = (ax - panX) / scale, py = (ay - panY) / scale;
      s.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120, clientX: r.left + ax, clientY: r.top + ay }));
      return { px, py, ax, ay };
    })()`,
  );
  await sleep(150);
  const afterWheel = await evalJson<any>(wc, IMG_STATE);
  const newScale = parseFloat(afterWheel.w) / afterWheel.naturalW;
  check("8k: Ctrl+滚轮放大", newScale > 1, `scale=${newScale.toFixed(2)}`);
  // 锚点保持：光标处的图片点不变
  const nowX = (wheelState.ax - afterWheel.panX) / newScale;
  const nowY = (wheelState.ay - afterWheel.panY) / newScale;
  check(
    "8k: 缩放围绕光标（锚点保持）",
    Math.abs(nowX - wheelState.px) < 2 && Math.abs(nowY - wheelState.py) < 2,
    `(${nowX.toFixed(1)},${nowY.toFixed(1)}) vs (${wheelState.px.toFixed(1)},${wheelState.py.toFixed(1)})`,
  );

  // 双击语义：非 100% → 100%；再双击 → fit
  await wc.executeJavaScript(
    `(() => { const s = document.querySelector('[data-testid="image-stage"]'); s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return true; })()`,
  );
  await sleep(150);
  const afterDbl1 = await evalJson<any>(wc, IMG_STATE);
  check("8k: 双击（非 100%）→ 100%", afterDbl1.scaleText.includes("100%"), afterDbl1.scaleText);
  await wc.executeJavaScript(
    `(() => { const s = document.querySelector('[data-testid="image-stage"]'); s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return true; })()`,
  );
  await sleep(150);
  const afterDbl2 = await evalJson<any>(wc, IMG_STATE);
  const fitScale2 = parseFloat(afterDbl2.w) / afterDbl2.naturalW;
  check("8k: 再双击（100%）→ fit", fitScale2 < 0.2, `scale=${fitScale2.toFixed(3)}`);

  // reset → fit + 居中 pan
  await wc.executeJavaScript(`document.querySelector('[data-action="zoom-100"]').click()`);
  await sleep(100);
  await wc.executeJavaScript(`document.querySelector('[data-action="reset"]').click()`);
  await sleep(150);
  const afterReset = await evalJson<any>(wc, IMG_STATE);
  check("8k: reset → fit（居中 pan）", afterReset.panY > 0 && afterReset.panX >= 0, `(${afterReset.panX},${afterReset.panY})`);
}

async function scenarioWide(wc: Electron.WebContents): Promise<void> {
  const stage = await evalJson<{ w: number }>(
    wc,
    `(() => { const s = document.querySelector('[data-testid="image-stage"]'); return { w: s.clientWidth }; })()`,
  );
  await wc.executeJavaScript(`document.querySelector('[data-action="fit-width"]').click()`);
  await sleep(150);
  const img = await evalJson<any>(wc, IMG_STATE);
  check("wide: fit-width 宽度适配", Math.abs(parseFloat(img.w) - stage.w) < 1.5, `${img.w} vs ${stage.w}`);
  check("wide: 横幅高度小（无需 pan）", parseFloat(img.h) < 300, `${img.h}px`);
}

async function scenarioTall(wc: Electron.WebContents): Promise<void> {
  const img = await evalJson<any>(wc, IMG_STATE);
  check("tall: 4096 超高解码", img.naturalW === 512 && img.naturalH === 4096);
  await wc.executeJavaScript(`document.querySelector('[data-action="fit-width"]').click()`);
  await sleep(150);
  const fitted = await evalJson<any>(wc, IMG_STATE);
  const dispH = parseFloat(fitted.h);
  check("tall: fit-width 高度溢出视口（可 pan）", dispH > 700, `${dispH}px`);
  check("tall: fit-width 垂直贴顶（panY≤0）", fitted.panY <= 0.5, `panY=${fitted.panY}`);
  // 垂直拖拽 pan（向上拖，查看下方内容；向下被贴顶钳制）
  await wc.executeJavaScript(
    `(() => {
      const s = document.querySelector('[data-testid="image-stage"]');
      const r = s.getBoundingClientRect();
      const fire = (t, x, y) => s.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      fire('mousedown', r.left + 200, r.top + 400);
      fire('mousemove', r.left + 200, r.top + 100);
      fire('mouseup', r.left + 200, r.top + 100);
      return true;
    })()`,
  );
  await sleep(150);
  const panned = await evalJson<any>(wc, IMG_STATE);
  check("tall: 垂直拖拽 pan 生效", panned.panY < -100, `panY ${fitted.panY} → ${panned.panY}`);
}

async function scenarioLeak(wc: Electron.WebContents): Promise<void> {
  // 预热：等首图完全挂载
  await waitFor(wc, `!!document.querySelector('.image-viewer-img')`, 30000);
  await sleep(800);
  const base = await evalJson<any>(wc, `window.__w5a.stats()`);
  check("leak: 基线单实例", base.active === 1 && base.viewerDom === 1, JSON.stringify(base));

  // 8K → zoom/pan → 4K → 8K → unmount
  await wc.executeJavaScript(`window.__w5a.renderImage('image-8k.png')`);
  await waitFor(wc, `(window.__w5a.stats().viewerDom === 1) && !!document.querySelector('.image-viewer-img') && document.querySelector('.image-viewer-img').naturalWidth === 7680`, 30000);
  await wc.executeJavaScript(`document.querySelector('[data-action="zoom-in"]').click()`);
  await sleep(150);
  await wc.executeJavaScript(`document.querySelector('[data-action="zoom-in"]').click()`);
  await sleep(150);
  await wc.executeJavaScript(
    `(() => { const s = document.querySelector('[data-testid="image-stage"]'); const r = s.getBoundingClientRect(); const f=(t,x,y)=>s.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0})); f('mousedown',r.left+100,r.top+100); f('mousemove',r.left+300,r.top+250); f('mouseup',r.left+300,r.top+250); return true; })()`,
  );
  await sleep(150);

  await wc.executeJavaScript(`window.__w5a.renderImage('image-4k.png')`);
  await waitFor(wc, `document.querySelector('.image-viewer-img')?.naturalWidth === 3840`, 30000);
  await sleep(300);
  await wc.executeJavaScript(`window.__w5a.renderImage('image-8k.png')`);
  await waitFor(wc, `document.querySelector('.image-viewer-img')?.naturalWidth === 7680`, 30000);
  await sleep(300);

  const mid = await evalJson<any>(wc, `window.__w5a.stats()`);
  check("leak: 切换过程无实例叠加", mid.active === 1 && mid.viewerDom === 1, JSON.stringify(mid));

  await wc.executeJavaScript(`window.__w5a.renderImage(null)`);
  await sleep(400);
  const end = await evalJson<any>(wc, `window.__w5a.stats()`);
  check("leak: unmount 后实例归零", end.active === 0 && end.viewerDom === 0, JSON.stringify(end));
  check("leak: stage 监听器归零", end.stageListeners === 0, String(end.stageListeners));
  check("leak: ResizeObserver 归零", end.observers === 0, String(end.observers));
  check("leak: 全程零 objectURL", end.objectUrlCalls === 0, String(end.objectUrlCalls));
}

async function scenarioChatSvg(wc: Electron.WebContents): Promise<void> {
  const state = await evalJson<{ naturalW: number; naturalH: number; src: string; status: string }>(
    wc,
    `(() => {
      const img = document.querySelector('.chat-inline-image');
      return {
        naturalW: img?.naturalWidth ?? 0,
        naturalH: img?.naturalHeight ?? 0,
        src: img?.getAttribute('src') ?? '',
        status: document.querySelector('.chat-image-status')?.textContent ?? '',
      };
    })()`,
  );
  check("chat-svg: 历史 image-kind SVG 在回复内实际解码", state.naturalW === 640 && state.naturalH === 420, `${state.naturalW}×${state.naturalH}`);
  check("chat-svg: 使用受控 Blob 图片源", state.src.startsWith("blob:"), state.src.slice(0, 24));
  check("chat-svg: 不降级成无法显示提示", state.status === "", state.status);
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
    ["img-basic", "?file=image-basic.png&kind=image", ".image-viewer-img", scenarioBasic],
    ["img-transparent", "?file=image-transparent.png&kind=image", ".image-viewer-img", scenarioTransparent],
    ["img-exif", "?file=image-exif-rotated.jpg&kind=image", ".image-viewer-img", scenarioExif],
    ["img-small", "?file=image-small.png&kind=image", ".image-viewer-img", scenarioSmall],
    ["img-8k", "?file=image-8k.png&kind=image", ".image-viewer-img", scenario8k],
    ["img-wide", "?file=image-wide.png&kind=image", ".image-viewer-img", scenarioWide],
    ["img-tall", "?file=image-tall.png&kind=image", ".image-viewer-img", scenarioTall],
    ["img-unicode", "?file=%E9%80%8F%E6%98%8E-%E5%9B%BE%E7%89%87.png&kind=image", ".image-viewer-img", scenarioTransparent],
    ["leak", "?file=image-basic.png&kind=image", ".image-viewer-img", scenarioLeak],
    ["chat-svg", "?file=svg-basic.svg&kind=chat-svg", ".chat-inline-image", scenarioChatSvg],
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
      // 解码/fit 稳定
      await sleep(600);
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
