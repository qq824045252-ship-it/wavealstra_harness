/** Isolated component behaviour/render checks. Headless runs do not replace packaged desktop acceptance. */
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { writeScreenshot, settleFramesScript } = require('./ui-capture.cjs');
const profile = mkdtempSync(join(tmpdir(), 'mybuddy-media-settings-ui-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
if (process.env.MYBUDDY_UI_HEADLESS === '1') {
  app.commandLine.appendSwitch('ozone-platform', 'headless');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  console.log('MODE headless component validation; not Windows desktop acceptance');
}
const timeout = setTimeout(() => { console.error('FAIL media settings UI timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const html = join(profile, 'fixture.html');
  writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><title>Media capability settings fixture</title></head><body></body></html>');
  await win.loadFile(html);
  await win.webContents.insertCSS(readFileSync(join(__dirname, '../out/tests/media-capabilities-ui.css'), 'utf8'));
  const bundle = readFileSync(join(__dirname, '../out/tests/media-capabilities-ui.js'), 'utf8');
  const passed = await win.webContents.executeJavaScript(bundle + '\nMediaCapabilitiesUI.run()');
  passed.forEach(result => console.log('PASS', result));
  const output = join(__dirname, '../out/tests/media-capabilities-screenshots');
  mkdirSync(output, { recursive: true });
  for (const [width, height, dark] of [[1280, 1000, false], [760, 900, false], [480, 900, true]]) {
    win.setContentSize(width, height);
    await win.webContents.executeJavaScript(`MediaCapabilitiesUI.preview(${dark})`);
    await win.webContents.executeJavaScript(settleFramesScript);
    console.log('PASS layout', await win.webContents.executeJavaScript('MediaCapabilitiesUI.layout()'));
    await writeScreenshot(win, join(output, `media-${width}.png`));
    await win.webContents.executeJavaScript('MediaCapabilitiesUI.showConnections()');
    await win.webContents.executeJavaScript(settleFramesScript);
    console.log('PASS connection layout', await win.webContents.executeJavaScript('MediaCapabilitiesUI.layout()'));
    await writeScreenshot(win, join(output, `connections-${width}.png`));
  }
  win.destroy(); clearTimeout(timeout); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
