const { app } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const profile = mkdtempSync(join(tmpdir(), 'mybuddy-python-electron-'));
app.setPath('userData', profile);
app.whenReady().then(async () => {
  console.log('Electron runtime ready', process.versions.electron);
  try {
    await import(pathToFileURL(join(__dirname, '../out/tests/python-runtime-live-test.mjs')).href);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
app.on('quit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
