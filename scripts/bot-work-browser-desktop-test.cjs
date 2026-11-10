/** Real Chromium layout/input on the actual task-browser component, synthetic Work only. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-browser-desktop-'));
app.setPath('userData', path.join(profile, 'chromium'));
app.whenReady().then(async () => {
  let win;
  try {
    const out = path.resolve('out/tests');
    const html = path.join(profile, 'fixture.html');
    fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(out, 'bot-work-browser-desktop-fixture.css')).href}"><style>
      :root{--bg-panel:#fafafa;--bg-elevated:#fff;--bg-hover:#f0f0f0;--bg-active:#ededed;--bg-input:#fff;--surface-right:#fff;--fg:#242424;--fg-secondary:#626262;--fg-muted:#777;--border-default:#ddd;--border-subtle:#e5e5e5;--border-strong:#aaa;--accent:#2f5bb5;--warning:#98620a;--success:#248056} body{margin:0;font:14px system-ui} #root,.bot-workspace,.bot-conversation{height:100vh}*{box-sizing:border-box}
      </style></head><body><div id="root"></div><script src="${pathToFileURL(path.join(out, 'bot-work-browser-desktop-fixture.js')).href}"></script></body></html>`);
    win = new BrowserWindow({ width: 1050, height: 820, show: true, webPreferences: { contextIsolation: true } });
    const errors = [];
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadFile(html);
    win.webContents.debugger.attach('1.3');
    const viewport = width => win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
    await viewport(1050);
    const screenshot = async name => { const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(out, name), Buffer.from(shot.data, 'base64')); };
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    const until = async (expression, label) => { const end = Date.now() + 8000; while (!await evaluate(expression)) { if (Date.now() > end) throw Error('timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 40)); } };
    const click = text => evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(text)}).click()`);
    const search = text => evaluate(`(()=>{ const input=document.querySelector('input[type=search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const filter = label => evaluate(`[...document.querySelectorAll('.bot-work-filters button')].find(button=>button.firstElementChild.textContent===${JSON.stringify(label)}).click()`);
    await until(`document.querySelectorAll('.bot-work-card').length === 24`, 'bounded initial page');
    assert(await evaluate(`document.querySelector('.bot-work-list-summary').textContent.includes('共 137 件 · 当前 1–24 件')`));
    await click('下一页'); await until(`document.querySelector('.bot-work-pagination').textContent.includes('第 2 / 6 页')`, 'second page');
    const selected = await evaluate(`document.querySelector('.bot-work-card').dataset.workId`);
    await evaluate(`document.querySelector('.bot-work-card').click()`);
    await until(`document.querySelector('.bot-work-card[aria-pressed=true]')?.dataset.workId === ${JSON.stringify(selected)}`, 'selected work');
    assert.deepEqual(await evaluate('window.browserFixtureSelected'), [selected]);
    await evaluate('window.refreshBrowserFixture(window.browserFixtureWorks.map(work => ({...work})))');
    await until(`document.querySelector('.bot-work-pagination').textContent.includes('第 2 / 6 页')`, 'refresh preserves page');
    await evaluate(`document.querySelector('.bot-work-browser').scrollTop=1000`);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert(await evaluate(`document.querySelector('input[type=search]').getBoundingClientRect().top >= document.querySelector('.bot-work-browser').getBoundingClientRect().top`), 'sticky search remains fully visible while scrolling');
    await filter('核对结果');
    await until(`document.querySelectorAll('.bot-work-card').length === 20`, 'execution-complete filter');
    assert.equal(await evaluate(`document.querySelector('.bot-work-browser').scrollTop`), 0, 'filter starts at first result');
    assert(await evaluate(`[...document.querySelectorAll('.bot-work-card .bot-status-badge')].every(item=>item.textContent==='正在核对结果')`), 'execution completion does not claim accepted closure');
    await filter('需处理');
    await until(`document.querySelectorAll('.bot-work-card').length === 24`, 'attention page bound');
    assert(await evaluate(`[...document.querySelectorAll('.bot-work-card .bot-status-badge')].every(item=>/状态待核对|未完成/.test(item.textContent))`));
    await search('does-not-exist');
    await until(`document.body.textContent.includes('没有找到匹配的事项')`, 'empty result');
    await click('查看全部事项');
    await until(`document.querySelectorAll('.bot-work-card').length === 24 && document.querySelector('input').value === ''`, 'clear search and filter');
    await search('ＡＣＭＥ 136');
    await until(`document.querySelectorAll('.bot-work-card').length === 1`, 'search target beyond title and first page');
    assert.equal(await evaluate(`document.querySelector('.bot-work-card').dataset.workId`), 'work-136');
    await evaluate(`document.querySelector('[aria-label="清除搜索"]').click()`);
    await until(`document.querySelectorAll('.bot-work-card').length === 24`, 'clear query');
    await evaluate(`(()=>{const select=document.querySelector('[aria-label="事项排序"]');select.value='oldest';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(`document.querySelector('.bot-work-card').dataset.workId === 'work-0'`, 'oldest first');
    for (let index = 0; index < 5; index++) { await click('下一页'); await until(`document.querySelector('.bot-work-pagination').textContent.includes('第 ${index + 2} / 6 页')`, 'next page'); }
    assert.equal(await evaluate(`document.querySelectorAll('.bot-work-card').length`), 17);
    assert(await evaluate(`[...document.querySelectorAll('button')].find(item=>item.textContent==='下一页').disabled`));
    await evaluate('window.refreshBrowserFixture(window.browserFixtureWorks.slice(0,30))');
    await until(`document.querySelector('.bot-work-pagination').textContent.includes('第 2 / 2 页') && document.querySelectorAll('.bot-work-card').length === 6`, 'live shrink clamps page');
    await evaluate('window.refreshBrowserFixture(window.browserFixtureWorks)');
    await until(`document.querySelector('.bot-work-pagination').textContent.includes('第 2 / 6 页')`, 'live expansion does not restore stale page six');
    await click('上一页'); await until(`document.querySelector('.bot-work-card').dataset.workId === 'work-0'`, 'previous page');
    assert.equal(await evaluate('innerWidth'), 1050);
    await screenshot('bot-work-browser-desktop-wide.png');
    await viewport(440);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await evaluate('innerWidth'), 440);
    assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.bot-work-browser').scrollWidth <= document.querySelector('.bot-work-browser').clientWidth + 1`), 'narrow viewport has no horizontal overflow');
    assert(await evaluate(`[...document.querySelectorAll('.bot-work-card')].every(item=>item.getBoundingClientRect().height < 280)`), 'compact readable cards');
    await screenshot('bot-work-browser-desktop-narrow.png');
    await evaluate(`window.refreshBrowserFixture(window.browserFixtureWorks.map((work,index)=>({...work,lifecycle:'closed',closureConclusion:index%2?'cancelled':'succeeded'})));window.setBrowserFixtureView('closed')`);
    await until(`document.querySelector('[aria-label="其他记录事项"]') && document.querySelectorAll('.bot-work-card').length === 24`, 'switch resets browsing scope');
    assert(await evaluate(`[...document.querySelectorAll('.bot-work-card .bot-status-badge')].every(item=>item.textContent==='已取消')`), 'successful outcomes never leak into other records');
    await filter('已取消');
    await until(`document.querySelector('.bot-work-list-summary').textContent.includes('匹配 68 件')`, 'closed outcome filter');
    assert(await evaluate(`[...document.querySelectorAll('.bot-work-card .bot-status-badge')].every(item=>item.textContent==='已取消')`));
    await evaluate("window.setBrowserFixtureView('completed')");
    await until(`document.querySelector('[aria-label="已完成事项"]') && document.querySelectorAll('.bot-work-card').length === 24`, 'completed destination');
    assert(await evaluate(`[...document.querySelectorAll('.bot-work-card .bot-status-badge')].every(item=>item.textContent==='已完成')`), 'only succeeded appears in completed');
    assert(await evaluate(`!document.querySelector('.bot-work-filters')`), 'completed never offers unfinished subfilters');
    assert(await evaluate(`[...document.querySelectorAll('.bot-work-card')].every(item=>!item.textContent.includes('下一步：')&&!item.textContent.includes('等待成果'))`), 'closed cards do not display stale active instructions');

    for (const width of [390, 760, 1440]) {
      await viewport(width); await new Promise(resolve => setTimeout(resolve, 200));
      assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.bot-work-browser').scrollWidth <= document.querySelector('.bot-work-browser').clientWidth + 1`), 'no overflow at ' + width);
      assert(await evaluate(`[...document.querySelectorAll('.bot-view-tabs button > span:first-of-type')].every(item=>item.getBoundingClientRect().height < 25)`), 'navigation labels stay on one line at ' + width);
      await screenshot('bot-work-outcomes-' + width + '.png');
    }
    assert.deepEqual(errors, [], 'no renderer errors');
    console.log('PASS real Electron: 137 tasks, bounded pages, full-text search, status filters, closed outcomes, refresh/shrink/grow, selection, 440px layout');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
