const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, windowsHide: true, encoding: 'utf8', timeout: 45000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(root, 'out/remote-startup-profile'));
let win, server, mode = 'offline', calls = 0;
const sockets = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(source) { return win.webContents.executeJavaScript(source, true); }
async function until(source, timeout = 11000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(source)) return; await delay(100); }
  throw new Error('Timed out: ' + source);
}
app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/v1/')) {
      if (pathname === '/v1/bootstrap') calls++;
      if (mode !== 'online') {
        res.writeHead(mode === 'offline' ? 503 : 401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: mode === 'offline' ? 'Server starting' : 'Device revoked' } }));
      }
      if (pathname === '/v1/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(pathname === '/v1/bootstrap' ? { server: { now: Date.now() }, tasks: [], spaces: [], projects: [], models: [], device: { name: 'Fixture' }, unreadNotificationCount: 0 } : []));
    }
    const dist = path.join(root, 'app/remote/dist');
    const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(fs.readFileSync(file));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  win = new BrowserWindow({ show: false, width: 412, height: 915, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadURL(baseUrl);
  await evaluate('sessionStorage.setItem("mybuddy-remote-dev-credential", ' + JSON.stringify(JSON.stringify({ baseUrl, deviceToken: 'fixture-token' })) + ')');
  await win.loadURL(baseUrl);
  await until('document.querySelector(".onboard-error-banner")?.textContent.includes("Server starting")');
  assert.equal(calls, 1);
  mode = 'online';
  await until('!document.querySelector(".claude-onboard") && !!document.querySelector("main")');
  assert.equal(calls, 2);
  console.log('PASS production UI recovers from failed cold start without an online event or user action');
  assert.equal(await evaluate('!!JSON.parse(sessionStorage.getItem("mybuddy-remote-dev-credential")).deviceToken'), true);
  console.log('PASS saved pairing survives the startup failure');

  mode = 'unauthorized'; calls = 0;
  await win.loadURL(baseUrl);
  await until('document.querySelector(".onboard-error-banner")?.textContent.includes("Device revoked")');
  await delay(8000);
  assert.equal(calls, 1);
  assert.equal(await evaluate('!!document.querySelector(".claude-onboard")'), true);
  console.log('PASS production foreground timer does not retry revoked authorization');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); }).finally(() => {
  win?.destroy();
  for (const socket of sockets) socket.destroy();
  server?.close();
});
