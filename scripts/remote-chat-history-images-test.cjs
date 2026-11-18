/**
 * 安卓端聊天页现场复现：真实 App 组件 + offscreen Electron。
 *
 * 覆盖用户反馈的两类问题：
 *   A. 图片显示：归属（挂在哪条消息下）、是否掉进「其他图片」、点击查看原图能否取到流
 *   B. 上下对话加载：上拉更早历史（wheel / touch）、前插后的视觉锚点、后台同步不打断阅读
 *
 * 运行：node scripts/remote-chat-history-images-test.cjs
 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
process.chdir(path.resolve(__dirname, '..'));
const outDir = path.resolve('out/remote-tests/chat-history-images');

if (!process.versions.electron) {
  fs.mkdirSync(outDir, { recursive: true });
  require('esbuild').buildSync({
    entryPoints: ['scripts/remote-chat-history-images-fixture.tsx'], bundle: true, platform: 'browser', format: 'iife',
    jsx: 'automatic', outfile: path.join(outDir, 'fixture.js'), loader: { '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(path.join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [__filename]; if (env.REMOTE_TEST_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-gpu');
  const r = require('node:child_process').spawnSync(require('electron'), args, { env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.resolve('out/remote-tests/chat-history-images-profile'));
let win, failures = 0;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = (expression) => win.webContents.executeJavaScript(expression, true)
  .catch((error) => { throw Error('executeJavaScript 失败：' + expression.slice(0, 160) + ' → ' + error.message); });
async function stable(expression, label, ms = 4000) {
  const end = Date.now() + ms;
  let last = null, same = 0;
  while (Date.now() < end) {
    const value = await evalJs(expression);
    if (value !== null && value === last) { same += 1; if (same >= 3) return value; } else { same = 0; last = value; }
    await delay(40);
  }
  return last;
}
async function until(expression, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evalJs(expression)) return; await delay(25); }
  throw Error('Timeout: ' + label);
}
const pass = (name) => console.log('PASS ' + name);
function fail(name, detail) { failures += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))); }
function check(name, ok, detail) { ok ? pass(name) : fail(name, detail); }

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      width: 390, height: 844, useContentSize: true, show: false, offscreen: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    await win.loadFile(path.join(outDir, 'index.html'));
    await until('!!window.harness && document.querySelectorAll("[data-message-id]").length > 0', 'chat timeline rendered');
    await delay(120);

    // ───────────────────────────────── A. 图片：一条回复一行汇总
    const chips = await evalJs('window.harness.chipsByMessage()');
    check('一条回复只占一行图片 UI（durable-98 = 3 张图片）',
      JSON.stringify(chips['durable-98']) === JSON.stringify(['3 张图片']), chips);
    check('不再有任务末尾的图片区', await evalJs('window.harness.hasTaskImageBlock()') === false);
    check('正文里的图片引用不再单独渲染一张卡片（durable-98 只有一行）',
      (chips['durable-98'] || []).length === 1, chips['durable-98']);
    check('归属落在还没加载的更早历史里的图暂不渲染（不丢，等那一页上屏）',
      !JSON.stringify(chips).includes('old.png'), chips);

    const opened = await evalJs('window.harness.openChip("3 张图片")');
    check('点开汇总能打开图廊', opened === true, opened);
    await until('window.harness.gallery().length === 3', 'gallery renders three items', 8000);
    await until('window.harness.gallery().every(item => item.loaded)', 'gallery images decoded', 8000);
    const gallery = await evalJs('window.harness.gallery()');
    check('图廊列出本回复的全部图片并都能解码',
      gallery.length === 3 && gallery.map(item => item.name).sort().join('|') === 'live.png|shot.png|user.png', gallery);
    const imageCallsOpen = await evalJs('window.harness.imageCalls()');
    await evalJs('window.harness.syncTask()');
    await delay(350);
    check('图廊打开期间后台同步不重拉图片（会闪帧）',
      await evalJs('window.harness.imageCalls()') === imageCallsOpen,
      { imageCallsOpen, after: await evalJs('window.harness.imageCalls()') });
    await evalJs('window.harness.closeViewer()');
    await delay(120);
    check('关闭图廊后不再渲染图片覆盖层', await evalJs('window.harness.gallery().length') === 0);

    // 单张图片仍然是「一个名字一行」，并且点开就能看原图
    await evalJs('window.harness.resetWindow()');
    await delay(200);

    // ───────────────────────────────── B. 上拉加载更早历史（wheel）
    const before = await evalJs('({ ids: window.harness.ids(), scroll: window.harness.scroll() })');
    check('进入任务先渲染实时窗口（sizeof window = 6）', before.ids.length === 6, before.ids);
    await evalJs('window.harness.setScroll(0)');
    console.log('（诊断）上拉前 ' + JSON.stringify(await evalJs('({scroll: window.harness.scroll(), spacer: (document.querySelector(".chat-bottom-spacer")||{}).offsetHeight, composer: Math.round((document.querySelector(".claude-composer-wrapper")||{getBoundingClientRect:()=>({height:-1})}).getBoundingClientRect().height)})')));
    const anchorBefore = await evalJs('window.harness.offsetOf("durable-95")');
    await evalJs('window.harness.wheel(-120)');
    await until('document.querySelectorAll("[data-message-id]").length === 56', 'first older page prepended', 8000);
    const firstSample = await evalJs('window.harness.offsetOf("durable-95")');
    const stableAnchor = await stable('Math.round(window.harness.offsetOf("durable-95") * 10)');
    console.log('（诊断）提交后首采锚点偏移：' + firstSample + '，稳定后（×10）：' + stableAnchor);
    const afterPage1 = await evalJs('({ ids: window.harness.ids(), scroll: window.harness.scroll(), anchor: window.harness.offsetOf("durable-95"), calls: window.harness.calls() })');
    check('上拉第一页用 seed 游标请求（page:94）', afterPage1.calls.includes('page:94'), afterPage1.calls);
    check('第一页前插在时间轴最前面（durable-45 打头）', afterPage1.ids[0] === 'durable-45', afterPage1.ids.slice(0, 3));
    check('前插后读者视觉锚点不动（durable-95 偏移不变，且提交当帧即对齐）',
      anchorBefore !== null && firstSample !== null && Math.abs(firstSample - anchorBefore) <= 2,
      { anchorBefore, firstSample, stableAnchor, scroll: afterPage1.scroll });
    const chipsPage1 = await evalJs('window.harness.chipsByMessage()');
    check('更早历史块里的图归位到它自己的消息（durable-60 → old.png）',
      JSON.stringify(chipsPage1['durable-60']) === JSON.stringify(['old.png']), chipsPage1['durable-60']);
    check('整条时间轴仍然没有任务末尾图片区', await evalJs('window.harness.hasTaskImageBlock()') === false);
    // 单张图片：一行名字 + 点开看原图
    const openedSingle = await evalJs('window.harness.openChip("old.png")');
    check('单张图片点开能看原图', openedSingle === true, openedSingle);
    await until('window.harness.viewer()?.loaded === true', 'single image decoded', 8000);
    check('单张图片取流解码成功', (await evalJs('window.harness.viewer()')).loaded === true);
    await evalJs('window.harness.closeViewer()');
    await delay(120);

    // ───────────────────────────────── 第二页 + 到头
    await delay(700); // 让前插补偿守卫（40 帧）结束，手势冷却（250ms）也早已过去
    await evalJs('window.harness.setScroll(0)');
    await delay(80);
    await evalJs('window.harness.wheel(-120)');
    await until('document.querySelectorAll("[data-message-id]").length === 100', 'second older page prepended', 8000);
    const afterPage2 = await evalJs('({ ids: window.harness.ids(), calls: window.harness.calls() })');
    check('第二页用上一页的 page.before 前进（page:44）', afterPage2.calls.includes('page:44'), afterPage2.calls);
    check('到最老后时间轴从 durable-1 开始', afterPage2.ids[0] === 'durable-1', afterPage2.ids.slice(0, 3));
    await evalJs('window.harness.setScroll(0)');
    const callCount = await evalJs('window.harness.calls().length');
    await evalJs('window.harness.wheel(-120)');
    await delay(400);
    check('到底以后不再重复请求同一页', await evalJs('window.harness.calls().length') === callCount, await evalJs('window.harness.calls()'));

    // ───────────────────────────────── C. 后台同步不能打断阅读
    await evalJs('window.harness.setScroll(400)');
    const scrollBeforeSync = await evalJs('window.harness.scroll().top');
    const anchorBeforeSync = await evalJs('window.harness.offsetOf("durable-50")');
    await evalJs('window.harness.syncTask()');
    await delay(400);
    const afterSync = await evalJs('({ ids: window.harness.ids().length, scroll: window.harness.scroll().top, calls: window.harness.calls() })');
    check('后台主动同步后仍保留已加载的更早历史', afterSync.ids === 100, afterSync);
    check('后台同步不改写滚动位置', Math.abs(afterSync.scroll - scrollBeforeSync) <= 2, { scrollBeforeSync, after: afterSync.scroll });

    // 窗口前滚：seed 变了，已加载块必须整组作废（宁可重新按页加载，也不能静默缺消息）
    await evalJs('window.harness.rollWindow(60)');
    await delay(300);
    const afterRoll = await evalJs('window.harness.ids()');
    check('实时窗口前滚后丢弃过期块，只留实时窗口', afterRoll.length === 6 && afterRoll[0] === 'durable-95', afterRoll.slice(0, 3));

    // ───────────────────────────────── D. 请求飞行期间下方还在长（流式回复 / 图片解码）
    //  高度差公式会把「锚点下方的增长」也算进上方长高，补偿就多补多少 → 读者看到先跳再回来。
    await evalJs('window.harness.resetWindow()');
    await delay(250);
    await evalJs('window.harness.setScroll(0)');
    check('上拉到顶后不再被视为「在底部」（真机语义：新消息不应该把人拽走）',
      await evalJs('window.harness.showScrollBottom()') === true);
    const anchorMid = await evalJs('window.harness.offsetOf("durable-95")');
    await evalJs('window.harness.setPageDelay(600)');
    await evalJs('window.harness.wheel(-120)');
    await delay(120);
    await evalJs('window.harness.appendWindow([{ id: "durable-102", role: "user", createdAt: Date.now(), text: "STREAMING_GROWTH" }, { id: "durable-103", role: "assistant", createdAt: Date.now() + 5, text: "长回复内容。".repeat(200) }])');
    await until('window.harness.ids().length >= 58', 'prepend overlapped with growth below', 8000);
    const firstMid = await evalJs('window.harness.offsetOf("durable-95")');
    check('请求飞行期间下方长高，锚点仍然不跳（首采即对齐）',
      anchorMid !== null && firstMid !== null && Math.abs(firstMid - anchorMid) <= 2,
      { anchorMid, firstMid, scroll: await evalJs('window.harness.scroll()') });
    await evalJs('window.harness.setPageDelay(0)');

    // ───────────────────────────────── E. 触摸手势（Android WebView 没有 wheel）
    await evalJs('window.harness.resetWindow()');
    await delay(250);
    await evalJs('window.harness.setScroll(0)');
    await evalJs('window.harness.touch(120, 320)');
    await until('window.harness.calls().includes("page:94")', 'touch gesture triggers paging', 8000);
    pass('手指下拉到底部以上时也能触发更早历史（touchmove）');
  } catch (error) {
    failures += 1;
    console.log('FAIL 未捕获异常：' + (error && error.stack ? error.stack : error));
  } finally {
    console.log(failures ? `${failures} 项失败` : '全部通过');
    app.exit(failures ? 1 : 0);
  }
});
