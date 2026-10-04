const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
app.setPath('userData', mkdtempSync(join(require('node:os').tmpdir(), 'mybuddy-records-ui-')));
app.disableHardwareAcceleration();
const timeout = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadURL('about:blank');
  await win.webContents.insertCSS(readFileSync(join(__dirname, '../out/tests/settings-records-ui.css'), 'utf8'));
  const bundle = readFileSync(join(__dirname, '../out/tests/settings-records-ui.js'), 'utf8');
  const results = await win.webContents.executeJavaScript(bundle + '\nRecordsUI.run()');
  results.forEach((result) => console.log('PASS', result));
  const output = join(__dirname, '../out/tests/settings-records-screenshots');
  mkdirSync(output, { recursive: true });
  for (const [width, height, dark] of [[1280, 900, false], [760, 600, false], [640, 600, true]]) {
    win.setContentSize(width, height);
    for (const tab of ['archive', 'security']) {
      await win.webContents.executeJavaScript(`RecordsUI.preview('${tab}', ${dark})`);
      await new Promise((resolve) => setTimeout(resolve, 180));
      console.log('PASS layout', tab, await win.webContents.executeJavaScript('RecordsUI.layout()'));
      writeFileSync(join(output, `${tab}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      if (tab === 'security') {
        await win.webContents.executeJavaScript('RecordsUI.showSettings()');
        writeFileSync(join(output, `security-settings-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  win.destroy(); clearTimeout(timeout); app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
