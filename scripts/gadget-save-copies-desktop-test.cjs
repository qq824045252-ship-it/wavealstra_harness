/** GUI-classified real Electron renderer regression; no production app or data. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out/tests/gadget-save-copies');
if (process.argv.includes('--fixture-electron')) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('userData', process.env.GADGET_COPY_FIXTURE_HOME);
  app.whenReady().then(() => {
    const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    const timer = setTimeout(() => { console.error('Renderer fixture timed out'); app.exit(1); }, 60000);
    ipcMain.once('fixture-result', (_event, report) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      app.exit(report.status === 'passed' ? 0 : 1);
    });
    win.loadFile(path.join(output, 'index.html'));
  });
} else {
  (async () => {
    fs.mkdirSync(output, { recursive: true });
    const home = fs.mkdtempSync(path.join(output, 'profile-'));
    await require('esbuild').build({ absWorkingDir: root, entryPoints: ['scripts/gadget-save-copies-desktop-fixture.tsx'], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: path.join(output, 'fixture.js'), alias: {
      '@/store/appStore': './scripts/gadget-save-copies-desktop-fixture.tsx',
      '@': './src/renderer/src', '@shared': './src/shared',
    } });
    fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
    const env = { ...process.env, GADGET_COPY_FIXTURE_HOME: home, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), PI_CODING_AGENT_DIR: path.join(home, '.mybuddy') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = cp.spawn(require('electron'), [__filename, '--fixture-electron'], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
