/**
 * Real-render regression for the multi-model-consult card.
 * Bundled by `test:consult-card-ui` from scripts/consult-card-ui-fixture.tsx.
 *
 * Guards the three reported defects:
 *  1. the detail panel is a floating card sized inside the viewport (never the old full-height modal)
 *  2. a still-running participant exposes a direct terminate switch that reaches the main process
 *  3. "基于此发现继续调查" works for completed AND failed/interrupted participants, without "undefined"
 */
const { app, BrowserWindow } = require('electron');
const { writeScreenshot, settleFramesScript } = require('./ui-capture.cjs');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const output = join(__dirname, '../out/tests');
const shots = join(output, 'consult-card-ui');
app.setPath('userData', join(output, 'consult-card-ui-profile'));
app.disableHardwareAcceleration();
const timeout = setTimeout(() => { console.error('consult-card-ui timed out'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1360, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const evaluate = async (code) => win.webContents.executeJavaScript(code);
  // 隐藏窗口的 setContentSize 在 Linux 上不可靠（实测有时完全不生效），响应式布局断言会随机失败。
  // 改用 CDP 的设备度量覆盖：确定性设置 viewport，不依赖真实窗口能否 resize。
  const debuggerApi = win.webContents.debugger;
  let viewportOverride = false;
  try { debuggerApi.attach('1.3'); viewportOverride = true; }
  catch (error) { console.warn('[consult-card-ui] 无法 attach debugger，退回 setContentSize：', error?.message ?? error); }
  const setViewport = async (width, height) => {
    if (viewportOverride) {
      await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    } else {
      win.setContentSize(width, height);
    }
  };
  const settle = () => evaluate(settleFramesScript);
  const checks = [];
  const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS', name); };
  const wait = async (code, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`wait timed out: ${code}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const screenshot = async (name) => {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await writeScreenshot(win, join(shots, `${name}.png`));
  };
  try {
    mkdirSync(shots, { recursive: true });
    const html = join(output, 'consult-card-ui.html');
    writeFileSync(html, '<!doctype html><html lang="zh"><meta charset="UTF-8"><div id="root"></div><link rel="stylesheet" href="consult-card-ui.css"><script src="consult-card-ui.js"></script></html>');
    await win.loadFile(html);
    await wait('Boolean(window.consultCardTest) && document.querySelectorAll("[data-testid^=consult-worker-]").length === 3');
    // 固定桌面视口：CI runner 的虚拟屏只有 1024x768，窗口尺寸会被宿主钳制，
    // 之前 1008x655 与本地 1360x1000 混用，拖拽/尺寸断言随机器漂移。这里显式统一。
    await setViewport(1008, 655);
    await settle();

    // ---- 1. Floating detail panel geometry ----
    await evaluate('window.consultCardTest.openDetails()');
    await wait('window.consultCardTest.dialogOpen()');
    const desktop = await evaluate('window.consultCardTest.dialogRect()');
    console.log('RECT desktop', JSON.stringify(desktop));
    await check('detail panel opens as a dialog', async () => assert(Boolean(desktop)));
    await check('desktop panel stays inside the viewport instead of filling it', async () => {
      assert(desktop.left >= -0.5 && desktop.top >= -0.5 && desktop.right <= desktop.viewportWidth + 0.5 && desktop.bottom <= desktop.viewportHeight + 0.5, JSON.stringify(desktop));
      assert(desktop.width <= Math.min(720, desktop.viewportWidth - 40) + 1, `panel too wide: ${desktop.width}`);
      assert(desktop.height <= Math.min(desktop.viewportHeight - 96, 760) + 1, `panel too tall: ${desktop.height}`);
    });
    await check('desktop panel is horizontally centred with a top offset', async () => {
      const centre = desktop.left + desktop.width / 2;
      assert(Math.abs(centre - desktop.viewportWidth / 2) < 2, `not centred: ${centre} vs ${desktop.viewportWidth / 2}`);
      assert(desktop.top > 4 && desktop.top < 120, `unexpected top offset: ${desktop.top}`);
    });
    await check('wide layout uses the vertical participant list', async () => assert.equal(await evaluate('window.consultCardTest.bodyDirection()'), 'row'));
    await check('every participant is listed with model, level and status', async () => {
      const tabs = await evaluate('window.consultCardTest.tabs()');
      assert.equal(tabs.length, 3);
      assert(tabs[0].includes('Gemini 3.8 Flash') && tabs[0].includes('思考等级 high') && tabs[0].includes('已完成'), tabs[0]);
      assert(tabs[0].includes('9.0 秒') || tabs[0].includes('3.0 秒'), `duration missing: ${tabs[0]}`);
      assert(tabs[0].includes('缓存读取 0.000M') && tabs[0].includes('缓存率 3%'), `raw cache metrics missing: ${tabs[0]}`);
      assert(tabs[1].includes('缓存读取 0.000M') && tabs[1].includes('缓存率 0%'), `known zero cache must be visible: ${tabs[1]}`);
      assert(tabs[2].includes('缓存读取 —') && tabs[2].includes('缓存率 —'), `missing cache must remain unknown: ${tabs[2]}`);
      assert(tabs[2].includes('失败'), tabs[2]);
    });
    await screenshot('detail-desktop');

    // Free-floating behaviour: the panel is content-sized and can be moved by its heading.
    await check('the panel sizes to its content instead of stretching to the maximum', async () => {
      assert(desktop.height < Math.min(desktop.viewportHeight - 96, 760) - 1, `panel stretched to its cap: ${desktop.height}`);
      assert(desktop.height > 240, `panel collapsed: ${desktop.height}`);
    });
    await check('dragging the heading moves the panel and double-click re-centres it', async () => {
      await evaluate('window.consultCardTest.dragBy(160, 90)');
      await settle();
      const moved = await evaluate('window.consultCardTest.dialogRect()');
      assert(Math.abs(moved.left - desktop.left - 160) < 3, `not dragged horizontally: ${moved.left} vs ${desktop.left}`);
      assert(Math.abs(moved.top - desktop.top - 90) < 3, `not dragged vertically: ${moved.top} vs ${desktop.top}`);
      // 面板是自由浮动窗口：产品只保证「至少留 120px 横向 / 56px 纵向可抓」的把手
      // （MultiModelConsultCard 的 clampedLeft/clampedTop），小视口下允许被拖出屏幕边缘。
      // 旧断言要求整块面板留在视口内，在 1008x655 的 CI runner 上必然失败（本地大窗口才碰巧通过）。
      const MIN_VISIBLE_X = 120;
      const MIN_VISIBLE_Y = 56;
      assert(
        moved.right >= MIN_VISIBLE_X - 0.5 && moved.left <= moved.viewportWidth - MIN_VISIBLE_X + 0.5,
        `dragged panel lost its horizontal handle: ${JSON.stringify(moved)}`,
      );
      assert(
        moved.top >= -0.5 && moved.top <= Math.max(0, moved.viewportHeight - MIN_VISIBLE_Y) + 0.5,
        `dragged panel lost its vertical handle: ${JSON.stringify(moved)}`,
      );
      await evaluate('window.consultCardTest.recenter()');
      await settle();
      // dblclick → React 提交 → 样式复位；隐藏窗口下这一拍可能晚于一帧，显式轮询到复位。
      await wait(`Math.abs(window.consultCardTest.dialogRect().left - ${desktop.left}) < 2 && Math.abs(window.consultCardTest.dialogRect().top - ${desktop.top}) < 2`, 5000);
      const recentred = await evaluate('window.consultCardTest.dialogRect()');
      assert(Math.abs(recentred.left - desktop.left) < 2 && Math.abs(recentred.top - desktop.top) < 2, `not recentred: ${JSON.stringify(recentred)}`);
    });
    await screenshot('detail-dragged-and-recentred');

    // Narrow viewport must fall back to the horizontal strip and still fit.
    await setViewport(420, 820);
    await settle();
    // 窗口尺寸变化要经过一次 layout + React 重渲染才反映到 bodyDirection；隐藏窗口下 rAF 可能不触发，
    // 固定 settle 存在竞态 → 显式轮询到目标布局（最多 3s），断言本身保留为最终校验。
    await wait('window.innerWidth <= 500', 3000);
    await settle();
    await wait('window.consultCardTest.bodyDirection() === "column"', 3000);
    const narrow = await evaluate('window.consultCardTest.dialogRect()');
    console.log('RECT narrow', JSON.stringify(narrow));
    await check('narrow viewport keeps the panel inside the screen', async () => {
      assert(narrow.left >= -0.5 && narrow.right <= narrow.viewportWidth + 0.5 && narrow.bottom <= narrow.viewportHeight + 0.5, JSON.stringify(narrow));
      assert(narrow.width <= narrow.viewportWidth - 40 + 1, `too wide: ${narrow.width}`);
    });
    await check('narrow layout falls back to the horizontal participant strip', async () => assert.equal(await evaluate('window.consultCardTest.bodyDirection()'), 'column'));
    await screenshot('detail-narrow');
    await setViewport(1360, 1000);
    await settle();
    await wait('window.innerWidth >= 1000', 3000);
    console.log('viewport after restore', await evaluate('window.innerWidth + "x" + window.innerHeight'));

    // ---- 3. Follow-up works for complete / failed / interrupted participants ----
    await check('follow-up is enabled for a completed participant', async () => {
      const state = await evaluate('window.consultCardTest.followupState()');
      assert.equal(state.disabled, false, JSON.stringify(state));
    });
    await evaluate('window.consultCardTest.clickFollowup()');
    await settle();
    const completedFollowUp = await evaluate('window.consultCardTest.appended().at(-1) ?? ""');
    await check('completed follow-up quotes the report, the participant and the real tool traces', async () => {
      assert(completedFollowUp.includes('tool-consult-1'), 'report id missing');
      assert(completedFollowUp.includes('google-vertex/gemini-3.8-flash'), 'participant identity missing');
      assert(completedFollowUp.includes('已完成'), 'status missing');
      assert(completedFollowUp.includes('vat-accounting.ts'), 'real tool trace missing');
      assert(!completedFollowUp.includes('undefined'), 'undefined leaked into the quoted text');
    });
    await check('follow-up gives visible feedback and closes the panel', async () => {
      assert((await evaluate('window.consultCardTest.notice()') ?? '').includes('已把'), 'no confirmation notice');
    });
    await screenshot('followup-notice');

    await evaluate('window.consultCardTest.openDetails()');
    await wait('window.consultCardTest.dialogOpen()');
    await evaluate('window.consultCardTest.clickTab(2)'); // the failed participant
    await settle();
    await check('a failed participant is still quotable instead of hard-disabled', async () => {
      const state = await evaluate('window.consultCardTest.followupState()');
      assert.equal(state.disabled, false, `failed participant blocked the follow-up: ${JSON.stringify(state)}`);
    });
    await evaluate('window.consultCardTest.clickFollowup()');
    await settle();
    const failedFollowUp = await evaluate('window.consultCardTest.appended().at(-1) ?? ""');
    await check('failed follow-up carries the recorded failure reason and no undefined', async () => {
      assert(failedFollowUp.includes('glm/glm-5.3-flash'), 'participant identity missing');
      assert(failedFollowUp.includes('429'), 'failure reason missing');
      assert(!failedFollowUp.includes('undefined'), 'undefined leaked into the quoted text');
    });

    // The interrupted case is the one that used to render "（undefined）".
    await evaluate('window.consultCardTest.render("interrupted")');
    await settle();
    await evaluate('window.consultCardTest.openDetails()');
    await wait('window.consultCardTest.dialogOpen()');
    await check('an interrupted report labels its unfinished participants as interrupted', async () => {
      const tabs = await evaluate('window.consultCardTest.tabs()');
      assert(tabs[1].includes('已中断'), `running participant not marked interrupted: ${tabs[1]}`);
      assert(tabs[2].includes('已中断'), `queued participant not marked interrupted: ${tabs[2]}`);
    });
    await evaluate('window.consultCardTest.clickTab(1)');
    await settle();
    await evaluate('window.consultCardTest.clickFollowup()');
    await settle();
    const interruptedFollowUp = await evaluate('window.consultCardTest.appended().at(-1) ?? ""');
    await check('interrupted follow-up never renders an undefined status', async () => {
      assert(interruptedFollowUp.includes('已中断'), 'interrupted status missing');
      assert(!interruptedFollowUp.includes('undefined'), 'undefined leaked into the quoted text');
    });
    await screenshot('followup-interrupted');

    // ---- 2. Direct terminate for a still-running participant ----
    await evaluate('window.consultCardTest.render("live")');
    await settle();
    const stopButtons = await evaluate('window.consultCardTest.stopButtons()');
    await check('a live participant exposes a direct terminate switch', async () => {
      assert.equal(stopButtons.length, 2, JSON.stringify(stopButtons));
      assert(stopButtons.every((label) => label.includes('终止')), JSON.stringify(stopButtons));
    });
    await evaluate('window.consultCardTest.clickStop(0)');
    await wait('window.consultCardTest.stopCalls().length === 1');
    const stopCall = await evaluate('window.consultCardTest.stopCalls()[0]');
    await check('terminate reaches the main process for exactly that participant', async () => {
      assert.deepEqual(stopCall, { taskId: 'task-consult', consultId: 'tool-consult-3', workerIndex: 0 });
    });
    await screenshot('live-terminate');

    await check('a settled consultation exposes no terminate switch', async () => {
      await evaluate('window.consultCardTest.render("complete")');
      await settle();
      const labels = await evaluate('window.consultCardTest.stopButtons()');
      assert.equal(labels.length, 0, JSON.stringify(labels));
    });

    // A card rendered for another task must not quote into the current composer.
    await evaluate('window.consultCardTest.setActiveTask("task-other")');
    await evaluate('window.consultCardTest.render("complete")');
    await settle();
    await evaluate('window.consultCardTest.openDetails()');
    await wait('window.consultCardTest.dialogOpen()');
    await check('another task\'s consultation cannot be quoted into this composer', async () => {
      const state = await evaluate('window.consultCardTest.followupState()');
      assert.equal(state.disabled, true, JSON.stringify(state));
    });

    console.log(JSON.stringify({ suite: 'consult-card-ui', result: 'PASS', checks: checks.length }, null, 2));
    app.once('will-quit', () => clearTimeout(timeout));
    setImmediate(() => app.quit());
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
