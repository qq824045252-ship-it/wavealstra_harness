/**
 * 前插滚动补偿的真实 Chromium 验证（不依赖 Electron 打包的渲染端）。
 *
 * 为什么需要这条：`prependScrollTop` 的纯函数单测只能证明算术，证明不了
 * 「内容在上方变高后，把 scrollTop 加上同样的高度差，读者视觉锚点真的不动」。
 * 这条用真实 Chromium 布局 + 真实 `scrollHeight` 量三件事：
 *
 * 1. 前插不补偿 → 锚点元素相对容器顶部上移，漂移量 = 前插高度（对照组）；
 * 2. 前插 + `prependScrollTop` 补偿 → 锚点偏移在 ±1px 内不变（本次改动的核心假设）；
 * 3. 前插块里含异步增高（图片解码 / 字体回填）→ 布局时刻的补偿不够，之后还会漂移；
 *    此时再按高度差补偿一次即可拉回。这条把「已知限制 + 修正手段」一起锁住，
 *    避免以后有人以为同步补偿已经处理了异步增高。
 *
 * 运行：pnpm test:history-prepend-electron
 */
import { BrowserWindow, app } from "electron";
// 注入页面的是**真实实现**（不是镜像公式），否则测试会与产品代码各走一路
import { prependScrollTop } from "../src/renderer/src/lib/historyWindow";

const ROW_HEIGHT = 80;
const INSERT_ROWS = 3;

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #111; }
  /* 与 app/remote 的 .chat-timeline 一致：浏览器不做自动锚定，补偿必须由我们算 */
  #timeline { height: 320px; overflow-y: auto; overflow-anchor: none; }
  .row { height: ${ROW_HEIGHT}px; margin: 0; }
  .tail { height: 600px; }
</style></head><body>
<div id="timeline">
  <div id="older"></div>
  <div id="rows">${Array.from({ length: 20 }, (_, i) => `<div class="row" data-row="${i}"></div>`).join("")}</div>
  <div class="tail"></div>
</div>
<script>
  window.__state = { inserted: false, asyncHeight: false };
  /** 锚点相对滚动容器可视区顶部的偏移：补偿是否成功就看这个数 */
  window.anchorOffset = () => {
    const el = document.getElementById('timeline');
    const anchor = document.querySelector('[data-row="6"]');
    return anchor.getBoundingClientRect().top - el.getBoundingClientRect().top;
  };
  window.reset = () => {
    const el = document.getElementById('timeline');
    document.getElementById('older').innerHTML = '';
    el.scrollTop = 400;
    return { offset: window.anchorOffset(), scrollHeight: el.scrollHeight };
  };
  window.prepend = (compensate, asyncHeight) => {
    const el = document.getElementById('timeline');
    const older = document.getElementById('older');
    const before = { top: el.scrollTop, height: el.scrollHeight, offset: window.anchorOffset() };
    for (let i = 0; i < ${INSERT_ROWS}; i += 1) {
      const row = document.createElement('div');
      row.className = 'row';
      if (asyncHeight && i === 0) row.style.height = '0px';
      older.appendChild(row);
      if (asyncHeight && i === 0) {
        // 图片解码 / 字体回填的等价物：布局稳定之后才长高
        setTimeout(() => { row.style.height = '${ROW_HEIGHT}px'; }, 60);
      }
    }
    const afterLayout = el.scrollHeight;
    if (compensate) el.scrollTop = (${prependScrollTop.toString()})(before.top, before.height, afterLayout);
    return { before, afterLayout, afterTop: el.scrollTop, offset: window.anchorOffset() };
  };
  /** 异步增高落地之后，再按高度差补一次 */
  window.recompensate = (previousHeight) => {
    const el = document.getElementById('timeline');
    const grown = Math.max(0, el.scrollHeight - previousHeight);
    el.scrollTop += grown;
    return { grown };
  };
</script></body></html>`;

const checks: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  checks.push([name, pass, detail]);
}

async function main(): Promise<void> {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 520, height: 420 });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
  const run = <T>(script: string): Promise<T> => win.webContents.executeJavaScript(script, true) as Promise<T>;

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  // 1) 对照组：前插不补偿 → 锚点上移，漂移 = 前插高度
  const baseline = await run<{ offset: number; scrollHeight: number }>("window.reset()");
  const un = await run<{ before: { top: number; height: number; offset: number }; offset: number }>(
    "window.prepend(false, false)",
  );
  check(
    "without compensation the anchor drifts by the prepended height",
    Math.abs((un.offset - baseline.offset) - ROW_HEIGHT * INSERT_ROWS) <= 1,
    `drift=${(un.offset - baseline.offset).toFixed(1)}px expected=${ROW_HEIGHT * INSERT_ROWS}px`,
  );

  // 2) 实验组：前插 + prependScrollTop 补偿 → 锚点偏移不变
  const reset = await run<{ offset: number }>("window.reset()");
  const comp = await run<{ offset: number; afterTop: number; before: { top: number } }>("window.prepend(true, false)");
  check(
    "prependScrollTop keeps the visual anchor in place",
    Math.abs(comp.offset - reset.offset) <= 1,
    `offset ${reset.offset.toFixed(1)} → ${comp.offset.toFixed(1)}, scrollTop ${comp.before.top} → ${comp.afterTop}`,
  );

  // 3) 已知限制：前插块异步增高，布局时刻补偿不够；再补一次可拉回
  const resetAsync = await run<{ offset: number }>("window.reset()");
  const asyncPrepend = await run<{ afterLayout: number; offset: number; before: { height: number } }>(
    "window.prepend(true, true)",
  );
  check(
    "synchronous compensation lands the anchor before async growth",
    Math.abs(asyncPrepend.offset - resetAsync.offset) <= 1,
    `offset ${resetAsync.offset.toFixed(1)} → ${asyncPrepend.offset.toFixed(1)}`,
  );
  await wait(150);
  const drifted = await run<number>("window.anchorOffset()");
  const stillAligned = Math.abs(drifted - resetAsync.offset) <= 1;
  const recovered = await run<{ grown: number }>(`window.recompensate(${asyncPrepend.afterLayout})`);
  const afterRecompensate = await run<number>("window.anchorOffset()");
  check(
    "async growth drifts and a second compensation restores the anchor",
    Math.abs(afterRecompensate - resetAsync.offset) <= 1,
    `afterAsync=${drifted.toFixed(1)} (aligned=${stillAligned}) secondCompensation=${recovered.grown}px → ${afterRecompensate.toFixed(1)}`,
  );

  for (const [name, pass, detail] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  const failed = checks.filter(([, pass]) => !pass);
  console.log(`\n===== HistoryPrependScroll: ${checks.length - failed.length}/${checks.length} passed =====`);
  win.destroy();
  app.exit(failed.length ? 1 : 0);
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
