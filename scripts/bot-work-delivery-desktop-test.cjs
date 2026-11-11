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
    fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(out, 'bot-work-delivery-desktop-fixture.css')).href}"><style>
      :root{--bg-panel:#fafafa;--bg-elevated:#fff;--bg-hover:#f0f0f0;--bg-active:#ededed;--bg-input:#fff;--surface-right:#fff;--fg:#242424;--fg-secondary:#626262;--fg-muted:#777;--border-default:#ddd;--border-subtle:#e5e5e5;--border-strong:#aaa;--accent:#2f5bb5;--warning:#98620a;--success:#248056} body{margin:0;font:14px system-ui} #root,.bot-workspace,.bot-conversation{height:100vh}*{box-sizing:border-box}
      </style></head><body><div id="root"></div><script src="${pathToFileURL(path.join(out, 'bot-work-delivery-desktop-fixture.js')).href}"></script></body></html>`);
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
    await until(`document.querySelector('.bot-result-report')`, 'report visible');
    assert(await evaluate(`document.querySelector('.bot-result-report').textContent.includes('14 项复算一致')`));
    await evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('合作完成一个项目')).click()`);
    assert.deepEqual(await evaluate('window.deliverySelected'), ['team-1']);
    await evaluate(`[...document.querySelectorAll('.bot-work-file')].length`);
    await evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('打开保存版本')).click()`);
    await until(`window.deliveryOpened.length === 1`, 'file open');
    assert.deepEqual(await evaluate('window.deliveryOpened'), ['/fixture/report.md']);
    await evaluate(`document.querySelector('textarea').value='新任务仍可输入'`);
    assert.equal(await evaluate(`document.querySelector('textarea').value`), '新任务仍可输入');
    await screenshot('bot-work-delivery-desktop.png');
    await viewport(440);
    assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth`));
    assert(await evaluate(`!document.body.textContent.includes('任务收件箱') && document.querySelectorAll('.bot-thread').length === 1`), 'one natural conversation stream');
    // Native Chromium input, not a DOM .click(): exercise the early file entry
    // on the real main-chat message component at desktop and narrow widths.
    const nativeClick = async selector => {
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',...point,clickCount:1});
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',...point,clickCount:1});
      await new Promise(resolve => setTimeout(resolve,100));
    };
    for (const width of [1050,440]) {
      await viewport(width);
      for (const mode of ['milestone','refreshed']) {
        await evaluate(`window.deliveryFixture.render(${JSON.stringify(mode)})`);
        await until(`document.querySelector('.bot-status-badge')?.textContent==='阶段成果'`, 'milestone report');
        assert(await evaluate(`document.querySelector('.bot-result-report').textContent.includes('不代表整体目标已完成')`));
        assert(await evaluate(`document.querySelector('.bot-result-report').textContent.includes('当前可用文件')`));
        assert.equal(await evaluate(`document.querySelectorAll('.bot-result-files button').length`),1,'only saved early A opens, including after refreshed B is registered');
        const before = await evaluate('window.deliveryOpened.length');
        await nativeClick('[aria-label="打开 A.md"]');
        await until(`window.deliveryOpened.length === ${before+1}`, 'native early file button');
        assert.equal((await evaluate('window.deliveryOpened')).at(-1),'/saved/A-v1.md','the old saved version never drifts to current A-v2');
        assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'),'milestone has no overflow');
        assert(await evaluate(`!document.querySelector('[data-outcome]') && !document.body.textContent.includes('本次交付')`),'no fabricated final outcome');
      }
      await screenshot(`bot-work-milestone-delivery-${width}.png`);
    }
    await evaluate('window.deliveryFixture.render("error")');
    await nativeClick('[aria-label="打开 A.md"]');
    await until(`document.querySelector('[role="alert"]')?.textContent.includes('保存文件暂不可用')`, 'open error');
    await evaluate('window.deliveryFixture.render("milestone")');
    await nativeClick('[aria-label="打开 A.md"]');
    await until(`!document.querySelector('[role="alert"]')`, 'open retry clears error');
    await evaluate('window.deliveryFixture.render("legacy")');
    await until(`!document.querySelector('.bot-result-report') && document.body.textContent.includes('A 已核实可先使用')`, 'legacy text preserved');
    await evaluate('window.deliveryFixture.render("result")');
    await until(`document.querySelector('.bot-status-badge')?.textContent==='结果已返回'`, 'final report unaffected');
    assert.deepEqual(errors, []);
    console.log('PASS real Electron natural delivery and milestone file entry: native early-A click, frozen A-v1 after refresh, mutable/unregistered B disabled, replay, 2 widths, open error/retry, legacy text and final result preserved');
  } catch (error) { console.error(error); if(win) console.error(await win.webContents.executeJavaScript('document.body.innerText')); process.exitCode = 1; }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
