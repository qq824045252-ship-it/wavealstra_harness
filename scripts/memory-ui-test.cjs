// Build memory-ui-test.tsx as global MemoryUITest in out/tests/memory-ui.js first.
const { app, BrowserWindow } = require('electron');
const { writeScreenshot, settleFramesScript } = require('./ui-capture.cjs');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'mybuddy-memory-ui-')));
app.disableHardwareAcceleration();
const timeout = setTimeout(() => { console.error('Memory UI test timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 980, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadURL('about:blank');
  const bundle = readFileSync(join(__dirname, '../out/tests/memory-ui.js'), 'utf8');
  await win.webContents.insertCSS(readFileSync(join(__dirname, '../out/tests/memory-ui.css'), 'utf8'));
  const results = await win.webContents.executeJavaScript(bundle + '\nMemoryUITest.run()');
  results.forEach((result) => console.log('PASS', result));
  const output = join(__dirname, '../out/tests/memory-ui-screenshots');
  mkdirSync(output, { recursive: true });
  for (const [page, width, dark] of [['memory', 1280, false], ['memory', 540, false], ['skills', 1280, false], ['settings', 1280, false], ['memory', 540, true], ['delete', 1280, false], ['delete', 540, false], ['select', 1280, false], ['select', 540, true], ['select-delete', 540, false], ['scenarios', 1280, false], ['scene-delete', 540, true], ['scenario-select', 1280, false], ['scenario-select', 540, true], ['scenario-select-delete', 540, false], ['skill-history', 1280, false], ['skill-history', 540, true], ['skill-history-delete', 540, false], ['skill-queue', 1280, false], ['skill-queue', 540, true], ['skill-queue-modal', 1344, false], ['skill-queue-modal', 1024, true], ['skill-queue-modal', 760, false]]) {
    win.setContentSize(width, page === 'skill-queue-modal' ? 821 : 980);
    await win.webContents.executeJavaScript(`MemoryUITest.preview('${page}', ${dark})`);
    const layout = await win.webContents.executeJavaScript('MemoryUITest.layout()');
    console.log('PASS layout', page, dark ? 'dark' : 'light', JSON.stringify(layout));
    await win.webContents.executeJavaScript(settleFramesScript);
    await new Promise(resolve => setTimeout(resolve, 180));
    await writeScreenshot(win, join(output, `${page}-${width}-${dark ? 'dark' : 'light'}.png`));
  }
  await win.webContents.executeJavaScript('MemoryUITest.dispose()');
  await win.loadURL('about:blank');
  app.once('will-quit', () => clearTimeout(timeout));
  setImmediate(() => app.quit());
}).catch((error) => { console.error(error); app.exit(1); });
