/** Repair this workstation's MyBuddy shortcut identity after validating a packaged build. */
const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const exe = path.resolve(process.argv[2] || '');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const out = path.join(root, 'out/tests/chat-attachment-acp/deployment', version);
const report = { executable: exe, shortcuts: [] };

app.whenReady().then(() => {
  assert.equal(process.platform, 'win32');
  assert.equal(path.basename(exe), 'MyBuddy.exe');
  assert(fs.existsSync(exe));
  const exeRelative = path.relative(root, exe);
  assert(exeRelative && !exeRelative.startsWith('..') && !path.isAbsolute(exeRelative), 'packaged executable must belong to this repository');
  fs.mkdirSync(out, { recursive: true });
  const startMenu = path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs');
  const desktop = app.getPath('desktop');
  const desktopLinks = fs.readdirSync(desktop).filter(name => /^MyBuddy(?: \d+\.\d+\.\d+)?\.lnk$/i.test(name));
  assert.equal(desktopLinks.length, 1, 'expected exactly one existing MyBuddy Desktop shortcut');
  const paths = [path.join(startMenu, 'Electron.lnk'), path.join(startMenu, 'MyBuddy.lnk'), path.join(desktop, desktopLinks[0])];
  for (const file of paths) {
    if (!fs.existsSync(file)) continue;
    const before = shell.readShortcutLink(file);
    const targetRelative = path.relative(root, before.target);
    assert(targetRelative && !targetRelative.startsWith('..') && !path.isAbsolute(targetRelative), 'shortcut target must belong to this repository');
    if (path.basename(file) === 'Electron.lnk' && before.appUserModelId !== 'com.mybuddy.app') continue;
    const backup = path.join(out, path.basename(file) + '.before');
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    const details = path.basename(file) === 'Electron.lnk'
      ? { ...before, appUserModelId: 'com.mybuddy.app.dev' }
      : { ...before, target: exe, cwd: path.dirname(exe), icon: exe, iconIndex: 0, description: `MyBuddy ${version}`, appUserModelId: 'com.mybuddy.app' };
    assert(shell.writeShortcutLink(file, 'update', details), 'update shortcut failed: ' + file);
    const after = shell.readShortcutLink(file);
    assert.equal(after.appUserModelId, details.appUserModelId);
    if (path.basename(file) !== 'Electron.lnk') { assert.equal(after.target, exe); assert.equal(after.icon, exe); }
    let publishedFile = file;
    if (path.dirname(file) === desktop) {
      publishedFile = path.join(desktop, `MyBuddy ${version}.lnk`);
      if (publishedFile !== file) {
        assert(!fs.existsSync(publishedFile), 'refusing to overwrite another Desktop shortcut');
        fs.renameSync(file, publishedFile);
      }
      assert.equal(shell.readShortcutLink(publishedFile).target, exe);
    }
    report.shortcuts.push({ file: publishedFile, previousFile: file, backup, before, after });
  }
  report.status = 'passed';
  fs.writeFileSync(path.join(out, 'shortcuts.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app.quit());
