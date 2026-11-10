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
    assert.deepEqual(errors, []);
    console.log('PASS real Electron natural delivery: one conversation stream, task title/summary, exact work/file buttons, no inbox panel, composer available');
  } catch (error) { console.error(error); if(win) console.error(await win.webContents.executeJavaScript('document.body.innerText')); process.exitCode = 1; }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
