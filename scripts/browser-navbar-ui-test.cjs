// Bundle browser-navbar-ui-test.tsx to out/tests/browser-navbar-ui.js before running.
const { app, BrowserWindow } = require('electron');
const { readFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'mybuddy-navbar-test-')));
const timeout = setTimeout(() => app.exit(1), 20000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
  const bundle = readFileSync(join(__dirname, '../out/tests/browser-navbar-ui.js'), 'utf8');
  const results = await win.webContents.executeJavaScript(bundle + '\nBrowserNavTest.run()');
  for (const result of results) console.log('PASS', result);
  win.destroy();
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
