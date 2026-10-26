const { app, BrowserWindow } = require('electron');
const { writeScreenshot, settleFramesScript } = require('./ui-capture.cjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const output = join(__dirname, '../out/tests');
app.setPath('userData', join(output, 'project-activity-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 960, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('[renderer]', event.message); });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const wait = async (code) => {
    const deadline = Date.now() + 5000;
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`UI wait timed out: ${code}`);
      await new Promise((accept) => setTimeout(accept, 50));
    }
  };
  const click = (label) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/^\\+/, '').trim().startsWith(${JSON.stringify(label)}) && b.getClientRects().length); if(!b || b.disabled)throw Error('button unavailable: '+${JSON.stringify(label)}); b.click()})()`);
  const capture = async (name) => {
    await evaluate(settleFramesScript);
    await new Promise((accept) => setTimeout(accept, 100));
    await writeScreenshot(win, join(output, name));
  };
  const overflow = `[...document.querySelectorAll('.project-activity *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > document.querySelector('.project-activity').getBoundingClientRect().right + 1; }).map(el => el.className)`;
  try {
    mkdirSync(output, { recursive: true });
    const html = join(output, 'project-activity-ui.html');
    writeFileSync(html, '<!doctype html><html lang="zh"><meta charset="UTF-8"><link rel="stylesheet" href="project-activity-ui.css"><div id="root"></div><script src="project-activity-ui.js"></script></html>');
    for (const theme of ['light', 'dark']) {
      await win.loadFile(html, { query: { theme } });
      await wait(`document.body.innerText.includes('外部消息（alice）')`);
      assert.ok(await evaluate(`!!document.querySelector('[aria-label="项目动态"]')`));
      assert.deepEqual(await evaluate(overflow), [], 'nothing overflows the activity pane horizontally');
      await capture(`project-activity-${theme}.png`);
    }
    await click('成员动态');
    await wait(`document.body.innerText.includes('读取进度，写入slack')`);
    await capture('project-activity-all.png');
    await click('读取进度，写入slack');
    assert.equal(await evaluate('window.openedTask'), 't1');
    await click('待处理');
    await wait(`!document.body.innerText.includes('定时任务完成')`);
    assert.ok(await evaluate(`document.body.innerText.includes('外部消息（alice）')`));
    await click('全部');
    await click('发布留言');
    await wait(`!!document.querySelector('#project-post-draft')`);
    await click('导入纪要/文档');
    await wait(`!!document.querySelector('.project-doc-box')`);
    await capture('project-activity-compose.png');
    await win.setSize(620, 900);
    await click('取消');
    assert.deepEqual(await evaluate(overflow), [], 'narrow width does not overflow');
    await capture('project-activity-narrow.png');
    console.log('project activity Electron UI: PASS');
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
