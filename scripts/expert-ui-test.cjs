const { app, BrowserWindow } = require('electron');
const { writeScreenshot } = require('./ui-capture.cjs');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'mybuddy-expert-ui-')));
app.disableHardwareAcceleration();
const timer = setTimeout(() => { console.error('Expert UI timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 700, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  // 必须是真实的 file:// 文档：about:blank 是透明源，没有 crypto.subtle、localStorage 访问也会被拒，
  // 组件里的「辅助操作」幂等键（crypto.subtle + localStorage）会直接抛错，草稿请求根本发不出去。
  const page = join(__dirname, '../out/tests/expert-ui.html');
  writeFileSync(page, '<!doctype html><html lang="zh"><head><meta charset="UTF-8"></head><body></body></html>');
  await win.loadFile(page);
  const bundle = readFileSync(join(__dirname, '../out/tests/expert-ui.js'), 'utf8');
  await win.webContents.insertCSS(readFileSync(join(__dirname, '../out/tests/expert-ui.css'), 'utf8'));
  const results = await win.webContents.executeJavaScript(bundle + '\nExpertUITest.run()');
  results.forEach(result => console.log('PASS', result));
  const output = join(__dirname, '../out/tests/expert-ui-screenshots'); mkdirSync(output, { recursive: true });
  for (const [width, height] of [[1024, 640], [560, 640]]) {
    win.setContentSize(width, height);
    await win.webContents.executeJavaScript('ExpertUITest.preview()');
    await writeScreenshot(win, join(output, `expert-editor-${width}x${height}.png`));
    console.log('PASS viewport', width, height);
  }
  await win.webContents.executeJavaScript('ExpertUITest.dispose()');
  win.destroy(); clearTimeout(timer); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
