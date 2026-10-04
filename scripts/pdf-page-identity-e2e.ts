/**
 * PDF 页身份回归 E2E — 真实 Electron + 真实 legacy blob worker（pdf-runtime-preview 前置）
 *
 * 背景（用户手测 bug）：4 页 PDF 能加载，但无论跳转/选择第 1、2、3、4 页，
 * 看到的内容始终是第 4 页。wave5c-e2e 只断言「滚动位置 / 有无 canvas」，从不断言
 * 「可见 slot 的内容页身份」——因此漏掉了该 bug。
 *
 * 本脚本在同一 PdfViewer session 内逐页跳转 1→2→3→4→1，断言：
 *   - 可见 slot 的 data-index 与目标页一致（虚拟化 DOM 位置）
 *   - 可见 slot 的 textLayer 含目标页唯一标记（文本身份）
 *   - 可见 slot 的 canvas 缩略指纹 == 该页参考指纹（画布身份；防 textLayer 对而画布错）
 *   - 4 页参考指纹两两不同（防「所有页都是第 4 页」）
 *   - 最终所有已挂载 slot 与其自身页身份一致（防跨 slot 串页）
 *   - 快速跳转 1→4→2→3 每步都断言身份（清单 §3）
 *   - slot 几何硬断言：相邻 slot 间距 ≈ 真实页高（禁 10px 塌缩），scrollHeight 不退化到单页高（清单 §3.2）
 *   - 关闭→重开后跳页身份仍正确（防跨 session 的 proxy/cache 混用）
 *
 * 画布等待条件（清单 §3.1）：TextLayer ready 但 canvas 可能仍全白（空白指纹
 * 1c14b9c5eafcd593 / 99fb0dc5d7fcb193）——所有指纹断言前必须等 visiblePaintedFp
 * 非空（canvas 已真正绘制）。
 *
 * 每页唯一标记不写死在脚本里：运行前用 pdfjs（Node）抽取各页规范化文本的
 * 唯一前缀 token（跨页唯一校验，冲突自动加长窗口）——任何 ≥4 页、每页文本
 * 可区分的 PDF 都可跑（含用户真实文档，经 env PDF_IDENTITY_FILE 指定）。
 *
 * 前置：node scripts/build-pdf-runtime-preview.mjs
 * 运行：pnpm test:pdf-page-identity-e2e
 */
import { app, BrowserWindow, protocol } from "electron";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");
const PAGE =
  "file:///" + join(ROOT, "fixtures", "golden-pages", "pdf-runtime-preview.html").replace(/\\/g, "/");

const results: Array<[string, boolean, string]> = [];
/** identity 场景采样的参考指纹（供 fast-jump 场景复用，避免重复采样） */
let scenarioIdentityRefs: string[] = [];
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

/** React 19 受控输入：原生 setter + input 事件 */
async function setInput(wc: Electron.WebContents, selector: string, value: string): Promise<void> {
  await wc.executeJavaScript(
    `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
}

// ---------- Node 阶段：用 pdfjs 抽取每页唯一 token ----------

/**
 * 在独立 node ESM 进程里跑 pdfjs 抽取（与用户实证 probe 同一形态）：
 * pdfjs legacy 在 esbuild bundle 进 Electron 主进程后会缺 DOMMatrix（bundle 内
 * 模块初始化路径不同）；原生 node ESM 直导包则可用（fixture 解析/文本抽取）。
 */
function extractPageTokens(file: string): { numPages: number; tokens: string[] } {
  const script = `
    import { readFileSync } from "node:fs";
    import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
    const file = ${JSON.stringify(join(FIX, file))};
    const bytes = readFileSync(file);
    const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableAutoFetch: true, useSystemFonts: true }).promise;
    const texts = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const c = await page.getTextContent();
      texts.push(c.items.map((x) => x.str ?? "").join("").replace(/\\s+/g, ""));
    }
    await doc.loadingTask.destroy();
    process.stdout.write(JSON.stringify(texts));
  `;
  const res = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    cwd: ROOT,
  });
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || "").slice(0, 300));
  }
  const texts: string[] = JSON.parse(res.stdout);
  if (texts.length < 4) throw new Error(`页身份回归需要 ≥4 页，实际 ${texts.length} 页`);
  // 每页取一个跨页唯一的规范化子串：从 12 字符起，冲突则加长
  const tokens: string[] = [];
  for (let p = 0; p < texts.length; p += 1) {
    let len = 12;
    let token = "";
    for (;;) {
      token = texts[p].slice(0, len);
      const others = texts.filter((_, i) => i !== p);
      if (token.length >= 8 && !others.some((t) => t.includes(token))) break;
      if (len >= Math.max(200, texts[p].length)) {
        throw new Error(`第 ${p + 1} 页无法找到跨页唯一 token（文本与其他页过于相似）`);
      }
      len += 4;
    }
    tokens.push(token);
  }
  return { numPages: texts.length, tokens };
}

// ---------- 页面内助手（一次性注入） ----------

const INJECT_HELPERS = `(() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, '');
  const fp = (canvas) => {
    try {
      const w = 32, h = 32;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(canvas, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      for (let i = 0; i < d.length; i += 4) {
        h1 = Math.imul(h1 ^ d[i], 0x01000193) >>> 0;
        h1 = Math.imul(h1 ^ d[i + 1], 0x01000193) >>> 0;
        h1 = Math.imul(h1 ^ d[i + 2], 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ d[i + 3], 0x01000193) >>> 0;
      }
      return h1.toString(16) + h2.toString(16);
    } catch (e) { return 'fp-err:' + String(e).slice(0, 40); }
  };
  const slotState = (slot) => {
    const canvas = slot.querySelector('.pdf-canvas');
    const layer = slot.querySelector('.textLayer');
    const txt = layer ? norm(layer.textContent) : '';
    return {
      pageNumber: parseInt(slot.dataset.index ?? '-1', 10) + 1,
      text: txt.slice(0, 240),
      fp: canvas ? fp(canvas) : '',
    };
  };
  const visibleSlot = () => {
    const sc = document.querySelector('.pdf-viewer-scroll');
    if (!sc) return null;
    const sTop = sc.getBoundingClientRect().top;
    const sBottom = sc.getBoundingClientRect().bottom;
    let best = null, bestGap = Infinity;
    for (const slot of document.querySelectorAll('.pdf-page-slot')) {
      const r = slot.getBoundingClientRect();
      if (r.bottom < sTop + 4 || r.top > sBottom - 4) continue;
      const gap = Math.abs(r.top - sTop);
      if (gap < bestGap) { bestGap = gap; best = slot; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    const st = slotState(best);
    return { pageNumber: st.pageNumber, text: st.text, fp: st.fp, topGap: Math.round(r.top - sTop) };
  };
  const allSlots = () => Array.from(document.querySelectorAll('.pdf-page-slot')).map(slotState);
  const slotGeometry = () => {
    const sc = document.querySelector('.pdf-viewer-scroll');
    if (!sc) return null;
    const mounted = Array.from(document.querySelectorAll('.pdf-page-slot'))
      .map((slot) => ({
        page: parseInt(slot.dataset.index ?? '-1', 10) + 1,
        top: Math.round(slot.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop),
        height: Math.round(slot.getBoundingClientRect().height),
      }))
      .sort((a, b) => a.top - b.top);
    return {
      mounted,
      scrollHeight: sc.scrollHeight,
      clientHeight: sc.clientHeight,
      scrollTop: sc.scrollTop,
    };
  };
  const scale = () => document.querySelector('[data-testid="pdf-scale"]')?.textContent ?? '';
  // alpha:false 画布未绘制时是纯白；已绘制（含内容）时指纹必非白/非全零
  const WHITE_FP = '1c14b9c5eafcd593';
  const ZERO_FP = '99fb0dc5d7fcb193';
  const painted = (fp) => !!fp && fp !== WHITE_FP && fp !== ZERO_FP;
  const visiblePaintedFp = () => {
    const v = visibleSlot();
    if (!v || !painted(v.fp)) return null;
    return v.fp;
  };
  const scaleStable = async () => {
    const a = scale();
    await new Promise((r) => setTimeout(r, 350));
    return a === scale();
  };
  window.__pid = { norm, fp, visibleSlot, allSlots, slotGeometry, scale, visiblePaintedFp, painted, scaleStable };
  return true;
})()`;

// ---------- 跳转 + 等待可见页身份 ----------

async function jumpTo(wc: Electron.WebContents, page: number): Promise<void> {
  await setInput(wc, ".pdf-viewer-page-input", String(page));
  await sleep(60);
  await wc.executeJavaScript(`document.querySelector('[data-action="jump"]').click()`);
}

async function waitVisibleContains(wc: Electron.WebContents, token: string, timeout = 20000): Promise<boolean> {
  return waitFor(wc, `window.__pid.visibleSlot() && window.__pid.visibleSlot().text.includes(${JSON.stringify(token)})`, timeout);
}

/** 断言「跳到第 page 页后，可见 slot 就是第 page 页」（文本身份 + 画布指纹） */
async function assertVisiblePage(
  wc: Electron.WebContents,
  label: string,
  page: number,
  token: string,
  refFp: string,
): Promise<void> {
  const ok = await waitVisibleContains(wc, token);
  check(`${label}: 跳转第 ${page} 页后可见文本层含第 ${page} 页标记`, ok);
  await waitFor(wc, `window.__pid.visiblePaintedFp() !== null`, 15000);
  const s = await evalJson<any>(wc, `window.__pid.visibleSlot()`);
  if (!ok || !s) return;
  check(`${label}: 可见 slot 页号 = ${page}`, s.pageNumber === page, `slot=${s.pageNumber}`);
  check(`${label}: 可见画布指纹 = 第 ${page} 页参考`, s.fp === refFp, `fp=${s.fp} ref=${refFp}`);
}

/**
 * 清单 §3.2：slot 几何硬断言。
 * 历史 bug：react-virtual 以 ~10px 错误页高建 measurement cache →
 * 页 top = 33/43/53/63（重叠）。修复后 = 33/738/1444/2150。
 *
 * 断言：
 *  1. 相邻已挂载 slot 的间距（= 前一个 slot 的完整高度，含 PAGE_GAP）
 *     ≈ 已挂载 slot 中位高度，比例必须在 [0.6, 1.6]——10px 塌缩（比例 ~0.01）硬失败
 *  2. scrollHeight ≥ (numPages - 0.5) × 中位页高，且 ≥ 3 × 视口高——
 *     退化到单页高度附近（~1.0×）硬失败
 */
async function assertSlotGeometry(
  wc: Electron.WebContents,
  numPages: number,
): Promise<void> {
  const g = await evalJson<any>(wc, `window.__pid.slotGeometry()`);
  if (!g || g.mounted.length < 2) {
    check("geo: 至少 2 个已挂载 slot 可供几何断言", false, JSON.stringify(g));
    return;
  }
  const heights = g.mounted.map((s: any) => s.height).sort((a: number, b: number) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  const spacings: number[] = [];
  for (let i = 1; i < g.mounted.length; i += 1) {
    spacings.push(g.mounted[i].top - g.mounted[i - 1].top);
  }
  const bad = spacings.filter((sp: number) => sp < median * 0.6 || sp > median * 1.6);
  check(
    `geo: 相邻 slot 间距 ≈ 真实页高（中位 ${median}px，禁 10px 塌缩）`,
    bad.length === 0,
    `spacings=${spacings.join(",")}`,
  );
  const expectScroll = Math.round((numPages - 0.5) * median);
  const multiViewport = g.clientHeight * 3;
  const target = Math.max(expectScroll, multiViewport);
  check(
    `geo: scrollHeight=${g.scrollHeight} 未退化到单页高（需 ≥ ${target}）`,
    g.scrollHeight >= target,
    `median=${median} clientH=${g.clientHeight}`,
  );
}

// ---------- 场景 ----------

async function scenarioIdentity(wc: Electron.WebContents, file: string, tokens: string[]): Promise<void> {
  await wc.executeJavaScript(`window.__w5a.renderPdf(${JSON.stringify(file)})`);
  const metaOk = await waitFor(wc, `(() => { const m = document.querySelector('.pdf-viewer-meta')?.textContent ?? ''; return /${tokens.length} 页/.test(m); })()`, 30000);
  check("identity: 解析完成（4 页元数据）", metaOk);
  await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-canvas')`, 30000);
  // 等 fit-scale 收敛（scale 变化会重跑渲染、画布被清空；指纹需在稳定尺度下采样）
  await waitFor(wc, `window.__pid.scaleStable()`, 15000);
  const stats = await evalJson<any>(wc, `window.__w5a.stats()`);
  check("identity: 真实 worker 路径（workers === 1）", stats.pdf.workers === 1, `workers=${stats.pdf.workers}`);

  // 参考指纹：逐页跳转采样（文本身份断言顺带在参考阶段即可抓住「都是第 4 页」）
  const refs: string[] = [];
  for (let p = 1; p <= tokens.length; p += 1) {
    await jumpTo(wc, p);
    const ok = await waitVisibleContains(wc, tokens[p - 1]);
    await waitFor(wc, `window.__pid.visiblePaintedFp() !== null`, 15000);
    const s = await evalJson<any>(wc, `window.__pid.visibleSlot()`);
    check(`ref: 第 ${p} 页跳转可见文本层含第 ${p} 页标记`, ok, s ? `text=${s.text}` : "no visible slot");
    refs.push(s?.fp ?? "");
    check(`ref: 第 ${p} 页画布指纹已采样（非空白）`, await evalJson<boolean>(wc, `window.__pid.painted(${JSON.stringify(s?.fp ?? "")})`), s?.fp ?? "");
    if (!ok) {
      await dumpSlots(wc, `ref-${p}`);
      break;
    }
  }
  const distinct = new Set(refs.filter(Boolean));
  check("ref: 4 页画布指纹两两不同（非全部同页）", distinct.size === tokens.length && distinct.size >= 2, refs.join(","));
  scenarioIdentityRefs = refs;

  // 主序列：1→2→3→4→1，逐步断言
  const seq = [1, 2, 3, 4, 1];
  for (const p of seq) {
    await jumpTo(wc, p);
    await assertVisiblePage(wc, `seq-${p}`, p, tokens[p - 1], refs[p - 1]);
  }

  // 最终：所有已挂载 slot 与自身页身份一致（文本 + 指纹）
  await sleep(800);
  const slots = await evalJson<any>(wc, `window.__pid.allSlots()`);
  const allOk =
    slots.length > 0 &&
    slots.every((s: any) => s.text.includes(tokens[s.pageNumber - 1]) && s.fp === refs[s.pageNumber - 1]);
  check("final: 所有挂载 slot 文本层含自身页标记", allOk, JSON.stringify(slots));
  if (!allOk) await dumpSlots(wc, "final");

  // 滚动位置 sanity：可见 slot 顶部应贴近滚动容器顶部（align:start 跳转生效）
  const vs = await evalJson<any>(wc, `window.__pid.visibleSlot()`);
  check("final: 可见 slot 贴近视口顶部", vs != null && Math.abs(vs.topGap) <= 24, JSON.stringify(vs));

  // 清单 §3.2：slot 几何硬断言（10px 塌缩回归锁）
  await assertSlotGeometry(wc, tokens.length);
}

async function scenarioFastJumps(
  wc: Electron.WebContents,
  file: string,
  tokens: string[],
  refs: string[],
): Promise<void> {
  await wc.executeJavaScript(`window.__w5a.renderPdf(${JSON.stringify(file)})`);
  await waitFor(wc, `(() => { const m = document.querySelector('.pdf-viewer-meta')?.textContent ?? ''; return /${tokens.length} 页/.test(m); })()`, 30000);
  await sleep(1200);
  // 清单 §3：快速跳转 1→4→2→3，每次跳页都断言（身份 + 画布指纹）
  for (const p of [1, 4, 2, 3]) {
    await jumpTo(wc, p);
    await assertVisiblePage(wc, `fast-${p}`, p, tokens[p - 1], refs[p - 1]);
  }
  // 快速连续跳转（制造 renderTask cancel / 迟到完成竞态）→ 最终态断言
  for (const p of [1, 2, 3, 4, 1, 4, 2, 3]) {
    await jumpTo(wc, p);
    await sleep(50);
  }
  // 等所有挂载 slot 就绪（文本层非空 + 画布已绘制）再断言，避免采样到中间态
  await waitFor(
    wc,
    `(() => { const s = window.__pid.allSlots(); return s.length > 0 && s.every((x) => x.text.length > 0 && window.__pid.painted(x.fp)); })()`,
    20000,
  );
  const s = await evalJson<any>(wc, `window.__pid.visibleSlot()`);
  const slots = await evalJson<any>(wc, `window.__pid.allSlots()`);
  check("fast: 快速跳转后可见页身份正确（文本层）", s != null && s.text.includes(tokens[2]), s ? `page=${s.pageNumber} text=${s.text}` : "none");
  const allOk = slots.every((x: any) => x.text.includes(tokens[x.pageNumber - 1]));
  check("fast: 快速跳转后所有挂载 slot 与自身页一致", allOk, JSON.stringify(slots));
  if (!allOk) await dumpSlots(wc, "fast");
}

async function scenarioReopen(wc: Electron.WebContents, file: string, tokens: string[]): Promise<void> {
  // 打开 → 关闭 → 重开 → 跳到第 3 页
  await wc.executeJavaScript(`window.__w5a.renderPdf(${JSON.stringify(file)})`);
  await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-canvas')`, 30000);
  await sleep(600);
  await wc.executeJavaScript(`window.__w5a.renderPdf(null)`);
  const zero = await waitFor(wc, `window.__w5a.stats().pdf.workers === 0 && window.__w5a.stats().pdf.docs === 0`, 15000);
  check("reopen: 关闭后 workers/docs 归零", zero);
  await wc.executeJavaScript(`window.__w5a.renderPdf(${JSON.stringify(file)})`);
  await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-canvas')`, 30000);
  await sleep(1000);
  await jumpTo(wc, 3);
  const ok = await waitVisibleContains(wc, tokens[2], 30000);
  const s = await evalJson<any>(wc, `window.__pid.visibleSlot()`);
  check("reopen: 重开 session 跳第 3 页可见身份正确", ok, s ? `page=${s.pageNumber} text=${s.text}` : "no visible slot");
  await wc.executeJavaScript(`window.__w5a.renderPdf(null)`);
}

async function dumpSlots(wc: Electron.WebContents, tag: string): Promise<void> {
  try {
    const d = await evalJson<any>(
      wc,
      `(() => {
        const sc = document.querySelector('.pdf-viewer-scroll');
        return {
          meta: document.querySelector('.pdf-viewer-meta')?.textContent ?? '',
          scale: document.querySelector('[data-testid="pdf-scale"]')?.textContent ?? '',
          scrollTop: sc ? sc.scrollTop : -1,
          scrollHeight: sc ? sc.scrollHeight : -1,
          slots: Array.from(document.querySelectorAll('.pdf-page-slot')).map((slot) => {
            const canvas = slot.querySelector('.pdf-canvas');
            const layer = slot.querySelector('.textLayer');
            return {
              index: slot.dataset.index,
              top: Math.round(slot.getBoundingClientRect().top),
              text: layer ? (layer.textContent ?? '').replace(/\\s+/g, '').slice(0, 60) : '',
              fp: canvas ? window.__pid.fp(canvas) : '',
            };
          }),
        };
      })()`,
    );
    console.log(`[dump:${tag}] ${JSON.stringify(d, null, 1).slice(0, 1200)}`);
  } catch (e) {
    console.log(`[dump:${tag}] 失败: ${String(e)}`);
  }
}

// ---------- 主流程 ----------

// ---------- 装配 ----------

protocol.registerSchemesAsPrivileged([
  { scheme: "w5a-fixture", privileges: { standard: false, supportFetchAPI: true, corsEnabled: true } },
]);

app.on("window-all-closed", () => {});

async function run(): Promise<void> {
  // 额外文件（用户真实 PDF 复现）经 env PDF_IDENTITY_FILE 指定
  const extraFile = process.env.PDF_IDENTITY_FILE;

  const files: string[] = ["pdf-identity-4p.pdf"];
  if (extraFile) files.push(extraFile);

  const analyzed: Array<{ file: string; numPages: number; tokens: string[] }> = [];
  for (const file of files) {
    try {
      analyzed.push({ file, ...extractPageTokens(file) });
    } catch (e) {
      console.log(`[analyze] ${file} 失败: ${String(e).slice(0, 200)}`);
      check(`analyze: ${file} token 抽取`, false, String(e).slice(0, 200));
    }
  }
  const targets = analyzed.filter((a) => a.tokens.length >= 4);
  check("analyze: 至少一个 4 页以上可区分文档", targets.length >= 1, targets.map((t) => t.file).join(","));

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
  const consoleLines: string[] = [];
  win.webContents.on("console-message", (event: any) => {
    const d = event && typeof event === "object" && "message" in event ? event : null;
    if (d) consoleLines.push(String(d.message).slice(0, 200));
  });

  for (const t of targets) {
    console.log(`-- identity:${t.file} --`);
    try {
      await win.loadURL(PAGE + `?file=${encodeURIComponent(t.file)}&kind=pdf`);
      await sleep(400);
      await win.webContents.executeJavaScript(INJECT_HELPERS);
      await scenarioIdentity(win.webContents, t.file, t.tokens);
      const refs = scenarioIdentityRefs; // 由 identity 场景采样（模块级）
      await scenarioFastJumps(win.webContents, t.file, t.tokens, refs);
      await scenarioReopen(win.webContents, t.file, t.tokens);
    } catch (error) {
      check(`${t.file}: 场景异常`, false, String(error).slice(0, 200));
    }
  }

  const failed = results.filter(([, pass]) => !pass).length;
  console.log(`\nPDF Page Identity E2E: ${results.length - failed}/${results.length} PASS`);
  if (failed > 0) {
    console.log("--- 最近 console ---");
    for (const line of consoleLines.slice(-30)) console.log(`  | ${line.slice(0, 160)}`);
  }
  app.exit(failed === 0 ? 0 : 1);
}

void run();
