/** Owned pnpm dev lifecycle. The bootstrap only isolates paths and records identity. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { connect } = require('./desktop-cdp-client.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(100); }
  throw Error('timeout: ' + label);
}
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function sourceFingerprint(root) {
  const git = args => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 40e6 });
  const paths = ['src', 'scripts', 'shared', 'package.json', 'pnpm-lock.yaml', 'electron.vite.config.ts'];
  const names = [...new Set([...git(['ls-files', '-z', ...paths]).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z', ...paths]).split('\0')].filter(Boolean))].sort();
  const files = names.map(file => ({ file, sha256: fs.existsSync(path.join(root, file)) ? sha(fs.readFileSync(path.join(root, file))) : null }));
  return { commit: git(['rev-parse', 'HEAD']).trim(), sourceDigest: sha(JSON.stringify(files)), files };
}
function desktopPreflight() {
  assert(process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
    'A real or explicitly provisioned desktop display is required; no headless fallback.');
  assert(process.env.BOT_WORK_DEV_HEADLESS !== '1', 'This is desktop Electron acceptance; headless-renderer mode is not accepted.');
  assert(process.env.npm_execpath && fs.existsSync(process.env.npm_execpath),
    'Run through pnpm: pnpm exec node scripts/bot-task-reply-dev-test.cjs');
}
function isolatedEnvironment(home, extra = {}) {
  // Carry only OS launch/display settings. Ambient model keys, loader hooks and
  // user-selected Pi/agent/tool directories do not enter the synthetic profile.
  const keep = /^(?:PATH|Path|SystemRoot|WINDIR|windir|COMSPEC|ComSpec|PATHEXT|LANG|LC_.*|TZ|TERM|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XDG_SESSION_TYPE)$/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key)));
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData/Local'), TMPDIR: path.join(home, 'Temp'), TEMP: path.join(home, 'Temp'), TMP: path.join(home, 'Temp'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
    PI_CODING_AGENT_DIR: path.join(home, '.mybuddy'), MYBUDDY_AGENTS_DIR: path.join(home, '.mybuddy/plugins/agents'),
    MYBUDDY_TOOLS_DIR: path.join(home, '.mybuddy/tools'), PI_ALLOW_BROWSER_COOKIES: '0', FEYNMAN_ALLOW_BROWSER_COOKIES: '0', ...extra };
}

async function launch({ root, home, out, launchNumber }) {
  desktopPreflight();
  const port = await freePort(); let inspect;
  do { inspect = await freePort(); } while (inspect === port);
  const runDir = path.join(out, 'launch-' + launchNumber), devOutput = path.join(runDir, 'dev-output');
  const userData = path.join(home, 'electron'), bootstrap = path.join(runDir, 'bootstrap.cjs');
  const identityFile = path.join(runDir, 'identity.json'), token = crypto.randomUUID();
  fs.mkdirSync(runDir, { recursive: true });
  for (const dir of ['AppData/Roaming', 'AppData/Local', 'Temp', 'electron']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(bootstrap, [
    `const {createRequire}=require('node:module');const r=createRequire(${JSON.stringify(path.join(root, 'package.json'))});`,
    `const {app}=r('electron');app.setAppPath(${JSON.stringify(root)});app.setPath('userData',${JSON.stringify(userData)});`,
    `require('node:fs').writeFileSync(${JSON.stringify(identityFile)},JSON.stringify({pid:process.pid,token:process.env.BOT_TASK_REPLY_RUN_ID,home:process.env.HOME,userData:app.getPath('userData'),bootstrap:__filename,startedAt:Date.now()}));`,
    `require(${JSON.stringify(path.join(devOutput, 'main/index.js'))});`,
  ].join('\n'));
  const config = path.join(runDir, 'vite.config.mjs');
  fs.writeFileSync(config, `import config from ${JSON.stringify(path.join(root, 'electron.vite.config.ts').replaceAll('\\', '/'))};\nconst envDir=${JSON.stringify(home)};\nexport default {...config,main:{...config.main,envDir},preload:{...config.preload,envDir},renderer:{...config.renderer,envDir,cacheDir:${JSON.stringify(path.join(runDir, 'vite-cache'))}}};\n`);
  const env = isolatedEnvironment(home, {
    REMOTE_DEBUGGING_PORT: String(port), V8_INSPECTOR_PORT: String(inspect), BOT_TASK_REPLY_RUN_ID: token,
    ELECTRON_CLI_ARGS: JSON.stringify(['--remote-debugging-address=127.0.0.1', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows']) });
  const log = fs.openSync(path.join(runDir, 'dev.log'), 'w');
  const native = !/\.(?:cjs|mjs|js)$/i.test(process.env.npm_execpath);
  const args = ['dev', '--config', config, '--outDir', devOutput, '--entry', bootstrap];
  const child = cp.spawn(native ? process.env.npm_execpath : process.execPath,
    native ? args : [process.env.npm_execpath, ...args], { cwd: root, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', log, log] });
  let renderer, main, spawnError, stopped = false;
  child.once('error', error => { spawnError = error; });
  const requireElectron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root, 'package.json'))})('electron')`;
  const stop = async () => {
    if (stopped) return; stopped = true;
    try {
      if (main) {
        const owned = await main.evaluate(`process.env.BOT_TASK_REPLY_RUN_ID === ${JSON.stringify(token)} && process.env.HOME === ${JSON.stringify(home)}`).catch(() => false);
        if (owned) await main.evaluate(`setTimeout(()=>${requireElectron}.app.quit(),0);true`).catch(() => {});
      }
      renderer?.close(); main?.close();
      if (fs.existsSync(identityFile)) {
        const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
        assert(identity.token === token && identity.home === home && identity.bootstrap === bootstrap, 'owned main identity');
        const ownedMainAlive = () => {
          try { process.kill(identity.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
        };
        const deadline = Date.now() + 5000;
        while (ownedMainAlive() && Date.now() < deadline) await delay(100);
        if (ownedMainAlive()) {
          // Verify the unique bootstrap immediately before signalling only this main PID.
          const command = process.platform === 'linux' ? fs.readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8')
            : process.platform === 'win32' ? cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.pid}').CommandLine`], { encoding: 'utf8', windowsHide: true })
              : cp.execFileSync('ps', ['-p', String(identity.pid), '-o', 'command='], { encoding: 'utf8' });
          assert(command.includes(bootstrap), 'refusing to stop an unowned or reused PID');
          process.kill(identity.pid, 'SIGTERM');
          await until(() => !ownedMainAlive(), 'owned Electron main exits', 10000);
        }
      }
    } finally {
      // This group was created by spawn(detached), never a user-owned dev group.
      // The verified Electron main has already been asked to settle and quit.
      try {
        if (child.pid) {
          if (process.platform === 'win32') {
            if (child.exitCode === null) cp.execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } else try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          await until(() => child.exitCode !== null || child.signalCode !== null, 'owned pnpm launcher exits', 10000);
        }
      } finally { fs.closeSync(log); }
    }
  };
  try {
    const connecting = async (debugPort, target) => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw Error('pnpm dev exited ' + child.exitCode + '; see ' + path.join(runDir, 'dev.log'));
      try { return await connect({ port: debugPort, target, connectTimeoutMs: 2000 }); } catch { return false; }
    };
    main = await until(() => connecting(inspect, item => item.type === 'node'), 'owned main inspector');
    assert(await main.evaluate(`process.env.BOT_TASK_REPLY_RUN_ID === ${JSON.stringify(token)} && process.env.HOME === ${JSON.stringify(home)}`), 'main is this isolated launch');
    const nonceExpression = `globalThis[Symbol.for('mybuddy.dev-verification.launch')]=${JSON.stringify(token)};true`;
    const ownedWindows = await until(() => main.evaluate(`Promise.all(${requireElectron}.BrowserWindow.getAllWindows()
      .filter(window=>/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:|\\/)/.test(window.webContents.getURL()))
      .map(async window=>{await window.webContents.executeJavaScript(${JSON.stringify(nonceExpression)});return {windowId:window.id,webContentsId:window.webContents.id,rendererPid:window.webContents.getOSProcessId(),url:window.webContents.getURL()}}))`).then(windows => windows.length ? windows : false), 'owned renderer identity handshake');
    renderer = await until(() => connecting(port, item => item.type === 'page' && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(item.url)), 'owned dev renderer');
    assert(await renderer.evaluate(`globalThis[Symbol.for('mybuddy.dev-verification.launch')]===${JSON.stringify(token)}`), 'renderer belongs to the verified main before any UI action');
    await renderer.rpc('Page.enable');
    await renderer.rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    const versions = await main.evaluate('({electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome})');
    const bundles = ['main/index.js', 'preload/index.js'].map(file => ({ file, sha256: sha(fs.readFileSync(path.join(devOutput, file))) }));
    return { renderer, main, stop, identity: { ...identity, versions, bundles, ownedWindows, rendererUrl: renderer.target.url, devOutput, launcherPid: child.pid } };
  } catch (error) { await stop().catch(cleanup => { error.cleanupError = String(cleanup); }); throw error; }
}
module.exports = { launch, desktopPreflight, isolatedEnvironment, sourceFingerprint, until, delay };
