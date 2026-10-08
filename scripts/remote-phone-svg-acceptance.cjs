// Read existing conversation on the connected phone; never submit a prompt.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const serial = process.env.ADB_SERIAL;
if (!serial) throw Error('Set ADB_SERIAL to the verified device');
const folder = path.resolve('out/tests/android-svg-fix');
fs.mkdirSync(folder, { recursive: true });
let port, ws, seq = 0;
const pending = new Map();
function adb(args) {
  const r = spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.status !== 0) throw Error(String(r.error || r.stderr));
  return r.stdout.trim();
}
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw Error(r.result?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function until(expression) {
  for (let i = 0; i < 60; i++) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise(r => setTimeout(r, 250));
  }
  throw Error('Condition failed: ' + expression);
}
(async () => {
  const metadata = JSON.parse(fs.readFileSync('app/remote/android/app/build/outputs/apk/debug/output-metadata.json')).elements[0];
  assert.match(adb(['shell', 'dumpsys', 'package', 'com.mybuddy.remote']), new RegExp('versionCode=' + metadata.versionCode + '\\b'));
  const pid = adb(['shell', 'pidof', 'com.mybuddy.remote']).split(/\s+/)[0];
  const socket = adb(['shell', 'cat', '/proc/net/unix']).split(/\r?\n/).find(l => l.includes('@webview_devtools_remote_' + pid))?.split('@').at(-1);
  assert.ok(socket, 'WebView debugger available');
  port = adb(['forward', 'tcp:0', 'localabstract:' + socket]);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const target = targets.find(t => t.type === 'page' && t.url.startsWith('https://localhost'));
  assert.ok(target);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = event => {
    const m = JSON.parse(String(event.data)), p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await until('!!document.querySelector(".claude-header")');
  const title = '这个项目的进度怎么样了';
  if (await evaluate('document.querySelector(".header-title-chat")?.textContent') !== title) {
    assert.equal(await evaluate('!!document.querySelector("textarea")?.value'), false, 'Preserve unsent draft');
    await evaluate('document.querySelector("button[aria-label=菜单]").click()');
    await until('!!document.querySelector(".drawer-item-btn")');
    assert.equal(await evaluate(`(() => { const b = [...document.querySelectorAll('.drawer-item-btn')].find(b => b.textContent.includes(${JSON.stringify(title)})); b?.click(); return !!b; })()`), true, 'Screenshot conversation exists');
  }
  await until('document.querySelector(".md-svg-image")?.naturalWidth > 0');
  const result = await evaluate(`(() => ({
    title: document.querySelector('.header-title-chat')?.textContent,
    images: [...document.querySelectorAll('.md-svg-image')].map(i => ({ loaded: i.complete && i.naturalWidth > 0, width: i.naturalWidth, height: i.naturalHeight, displayWidth: i.getBoundingClientRect().width })),
    xmlSvgSourceBlocks: [...document.querySelectorAll('.code-block-container')].filter(e => e.querySelector('.code-block-header')?.textContent.startsWith('xml') && /^\\s*<svg[\\s>]/i.test(e.querySelector('code')?.textContent || '')).length,
    errors: [...document.querySelectorAll('.md-svg-error')].map(e => e.textContent)
  }))()`);
  assert.equal(result.title, title);
  assert.equal(result.xmlSvgSourceBlocks, 0);
  assert.ok(result.images.length > 0 && result.images.every(i => i.loaded && i.displayWidth > 0));
  await evaluate('document.querySelector(".md-svg-card").scrollIntoView({block:"center"})');
  await new Promise(r => setTimeout(r, 500));
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(folder, 'phone-svg.png'), Buffer.from(screenshot.data, 'base64'));
  fs.writeFileSync(path.join(folder, 'phone-results.json'), JSON.stringify({ ok: true, version: metadata.versionName, ...result }, null, 2));
  console.log(JSON.stringify({ ok: true, version: metadata.versionName, ...result }));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  ws?.close();
  if (port) adb(['forward', '--remove', 'tcp:' + port]);
});
