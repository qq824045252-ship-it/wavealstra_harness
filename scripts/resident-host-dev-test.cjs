const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root, 'package.json'))})('electron')`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-resident-dev-'));
const directory = path.join(home, '.mybuddy'); fs.mkdirSync(directory, { recursive: true });
const devOutput = path.join(root, 'out/diagnostics/resident-host', path.basename(home), 'dev-output'), bootstrap = path.join(home, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, [
  `const requireRoot=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});`,
  `const {app}=requireRoot('electron');app.setAppPath(${JSON.stringify(root)});app.setPath('userData',${JSON.stringify(path.join(home, 'electron'))});`,
  `require(${JSON.stringify(path.join(devOutput, 'main/index.js'))});`,
].join('\n'));
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ residentHostEnabled: true, memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false }));
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (read, label) => { const end = Date.now() + 120000; let last; while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch (error) { last = error; } await sleep(200); } throw Error(`timeout: ${label} ${last?.message || ''}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function connect(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(result => result.json());
  const target = targets.find(item => item.type === 'node' || item.type === 'page' && /^https?:/.test(item.url));
  if (!target) throw Error('no inspector target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let next = 0; const pending = new Map();
  socket.addEventListener('message', event => { const value = JSON.parse(String(event.data)); if (value.id) { const waiter = pending.get(value.id); pending.delete(value.id); if (value.error) waiter?.reject(Error(JSON.stringify(value.error))); else waiter?.resolve(value.result); } });
  return { socket, evaluate: async expression => {
    const id = ++next;
    const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('inspector eval timeout: ' + expression)); }, 15000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject }); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result?.value;
  } };
}
let residentPid, main, initialPid;
(async () => {
  const debug = await freePort(), inspect = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), REMOTE_DEBUGGING_PORT: String(debug), V8_INSPECTOR_PORT: String(inspect),
    ELECTRON_CLI_ARGS: JSON.stringify([`--user-data-dir=${path.join(home, 'electron')}`]) };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.APPDATA, { recursive: true }); fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  const log = fs.openSync(path.join(home, 'dev.log'), 'w');
  assert(process.env.npm_execpath, 'run through pnpm test script');
  const native = !/\.(cjs|mjs|js)$/i.test(process.env.npm_execpath);
  const devArgs = ['dev', '--outDir', devOutput, '--entry', bootstrap];
  cp.spawn(native ? process.env.npm_execpath : process.execPath, native ? devArgs : [process.env.npm_execpath, ...devArgs], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
  main = await until(() => connect(inspect), 'initial main inspector');
  initialPid = await main.evaluate('process.pid');
  const renderer = await until(() => connect(debug), 'initial UI renderer');
  await until(() => renderer.evaluate('Boolean(window.api?.agent?.getAppSettings)'), 'preload API');
  assert.equal(await renderer.evaluate('window.api.agent.getAppSettings().then(settings => settings.residentHostEnabled)'), true);
  await renderer.evaluate('setTimeout(() => window.close(), 50); true'); renderer.socket.close(); main.socket.close();
  await until(() => !alive(initialPid), 'client main exits');
  main = await until(async () => { const connection = await connect(inspect); const pid = await connection.evaluate('process.pid'); if (pid === initialPid) { connection.socket.close(); return; } return connection; }, 'new resident composition');
  residentPid = await main.evaluate('process.pid');
  await until(() => main.evaluate(`${electron}.BrowserWindow.getAllWindows().length===0 && ${electron}.app.isReady()`), 'resident ready without UI');
  assert.equal(await main.evaluate('process.argv.includes("--resident-host")'), true);
  const residentDebug = await until(() => {
    const output = fs.readFileSync(path.join(directory, 'logs/resident-launcher.log'), 'utf8');
    const match = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    return match && Number(match[1]);
  }, 'resident debugger listening on its own port');
  const reopened = cp.spawn(require('electron'), [bootstrap, `--user-data-dir=${path.join(home, 'electron')}`], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  await until(() => reopened.exitCode !== null, 'short UI client exits');
  const reopenedRenderer = await until(() => connect(residentDebug), 'reopened renderer from live dev server');
  await until(() => reopenedRenderer.evaluate('Boolean(window.api?.botWork)'), 'reopened preload');
  const hostStatus = await reopenedRenderer.evaluate('window.api.botWork.hostStatus()');
  assert.equal(hostStatus.isAuthority, true);
  assert.equal(await main.evaluate('process.pid'), residentPid);
  await reopenedRenderer.evaluate('setTimeout(() => window.close(), 50); true'); reopenedRenderer.socket.close();
  await until(async () => await main.evaluate(`${electron}.BrowserWindow.getAllWindows().length`) === 0, 'resident UI renderer closes');
  await main.evaluate(`setTimeout(()=>${electron}.app.quit(),50);true`); main.socket.close();
  await until(() => !alive(residentPid), 'resident stop');
  fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify({ status: 'passed', initialPid, residentPid, devOutput,
    isolatedHome: home, sameHostUiReopened: true, hostStatus, residentDebug }, null, 2));
  console.log(`resident-host-dev-test: PASS pnpm-dev clientPid=${initialPid} residentPid=${residentPid} same-host-ui-reopened isolatedHome=${home}`);
})().catch(error => { console.error(error, `isolatedHome=${home}`); process.exitCode = 1; }).finally(async () => {
  if (main) { if ((residentPid && alive(residentPid)) || (initialPid && alive(initialPid))) { try { await main.evaluate(`setTimeout(()=>${electron}.app.exit(1),20);true`); } catch {} } main.socket.close(); }
});
