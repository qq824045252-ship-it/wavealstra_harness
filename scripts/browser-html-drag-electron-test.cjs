const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path'); const { tmpdir } = require('node:os');
const { buildSync } = require('esbuild');
const root = mkdtempSync(join(tmpdir(), 'mybuddy-html-drag-'));
app.setPath('home', root); app.setPath('userData', join(root, 'profile')); app.on('window-all-closed', () => {});
const output = join(process.cwd(), 'out/tests/browser-html-drag'); mkdirSync(output, { recursive: true });
buildSync({ stdin: { contents: 'export {htmlDragFromSource} from "./src/main/capabilities/browser/BrowserHtmlDrag";export {AutomationScope} from "./src/main/capabilities/AutomationScope";export {pageInspectionService} from "./src/main/artifact/PageInspectionService";export {browserNativeInput} from "./src/main/capabilities/BrowserNativeInput";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: join(output, 'entry.cjs'), logLevel: 'silent' });
const { htmlDragFromSource, AutomationScope, pageInspectionService, browserNativeInput } = require(join(output, 'entry.cjs'));
let win; const checks = [], evidence = { electron: process.versions.electron, checks };
const guard = setTimeout(() => { console.error('native HTML drag test timed out'); app.exit(1); }, 30000);
const mark = value => { checks.push(value); console.log('PASS', value); };
(async () => {
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const html = `<style>body{margin:0;user-select:none}#source,#target,#plain{position:absolute;top:40px;width:150px;height:120px;background:#ccc}#source{left:20px}#target{left:400px}#plain{left:20px;top:220px}</style><div id=source draggable=true>Source</div><div id=target>Target</div><div id=plain>Not draggable</div><script>window.receipts=[];window.ends=[];window.dragActive=false;window.mouse=[];window.payload='source-generated-'+Math.random().toString(36);document.addEventListener('mousemove',e=>mouse.push(e.buttons));document.addEventListener('mouseup',e=>mouse.push(e.buttons));source.addEventListener('dragend',e=>{ends.push({trusted:e.isTrusted,dropEffect:e.dataTransfer.dropEffect});window.dragActive=false});source.addEventListener('dragstart',e=>{window.dragActive=true;receipts.push({kind:'start',trusted:e.isTrusted});e.dataTransfer.effectAllowed='copyMove';e.dataTransfer.setData('text/plain',payload);e.dataTransfer.setData('text/html','<b>'+payload+'</b>')});target.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'});target.addEventListener('drop',e=>{e.preventDefault();receipts.push({kind:'drop',trusted:e.isTrusted,text:e.dataTransfer.getData('text/plain'),html:e.dataTransfer.getData('text/html')})});</script>`;
  await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  const wc = win.webContents, session = pageInspectionService.acquire(wc, 'browser-host'); await session.attach(wc.debugger);
  const input = browserNativeInput(session), points = [{ x: 60, y: 80 }, { x: 450, y: 80 }];
  await htmlDragFromSource({ protocol: session, input, scope: new AutomationScope(undefined, 5000), points });
  const payload = await wc.executeJavaScript('payload'), receipts = await wc.executeJavaScript('receipts');
  evidence.receipts = receipts;
  assert.deepEqual(receipts, [{ kind: 'start', trusted: true }, { kind: 'drop', trusted: true, text: payload, html: `<b>${payload}</b>` }]);
  assert.deepEqual(await wc.executeJavaScript('ends'), [{ trusted: true, dropEffect: 'copy' }]);
  assert.equal(await wc.executeJavaScript('dragActive'), false);
  mark('trusted source dragstart and target drop preserve the original runtime-generated plain and HTML data');
  mark('successful drop sends exactly one trusted source dragend and clears source drag state');
  const controller = new AbortController(), calls = [];
  const abortProtocol = {
    subscribeProtocol: listener => session.subscribeProtocol(listener),
    protocolCommand: async (method, parameters, sessionId) => {
      calls.push({ method, parameters }); const result = await session.protocolCommand(method, parameters, sessionId);
      if (method === 'Input.dispatchDragEvent' && parameters.type === 'dragOver') controller.abort();
      return result;
    },
  };
  await assert.rejects(htmlDragFromSource({ protocol: abortProtocol, input, scope: new AutomationScope(controller.signal, 5000), points }), error => error.name === 'AbortError');
  assert(!calls.some(call => call.method === 'Input.dispatchDragEvent' && call.parameters.type === 'drop'));
  assert(calls.some(call => call.method === 'Input.cancelDragging'));
  assert.equal(calls.at(-1).method, 'Input.setInterceptDrags'); assert.equal(calls.at(-1).parameters.enabled, false);
  assert.equal((await wc.executeJavaScript('receipts')).filter(item => item.kind === 'drop').length, 1);
  assert.deepEqual(await wc.executeJavaScript('ends'), [{ trusted: true, dropEffect: 'copy' }, { trusted: true, dropEffect: 'none' }]);
  assert.equal(await wc.executeJavaScript('dragActive'), false);
  await input.send({ type: 'mouseMove', x: 700, y: 400 }); assert.equal(await wc.executeJavaScript('mouse.at(-1)'), 0);
  mark('cancellation after native dragover sends no drop and releases owned mouse and interception');
  const earlyAbort = new AbortController(), inputEvents = [];
  const earlyInput = { ...input, send: async event => { inputEvents.push(event.type); await input.send(event); if(event.type === 'mouseDown') earlyAbort.abort(); } };
  await assert.rejects(htmlDragFromSource({ protocol: session, input: earlyInput, scope: new AutomationScope(earlyAbort.signal), points }), error => error.name === 'AbortError');
  assert.deepEqual(inputEvents, ['mouseMove', 'mouseDown', 'mouseUp']);
  await input.send({ type: 'mouseMove', x: 700, y: 400 }); assert.equal(await wc.executeJavaScript('mouse.at(-1)'), 0);
  mark('cancellation after mouseDown releases only this operation held button before any source drag');
  assert.equal(await wc.executeJavaScript('ends.length'), 2);
  await assert.rejects(htmlDragFromSource({ protocol: session, input, scope: new AutomationScope(undefined, 5000), points: [{ x: 60, y: 260 }, { x: 450, y: 80 }] }), error => error.code === 'UNSUPPORTED_SCOPE');
  assert.equal((await wc.executeJavaScript('receipts')).filter(item => item.kind === 'drop').length, 1);
  mark('nondraggable source fails without synthetic payload, fallback or replay');
  await htmlDragFromSource({ protocol: session, input, scope: new AutomationScope(undefined, 5000), points });
  assert.equal((await wc.executeJavaScript('receipts')).filter(item => item.kind === 'drop').length, 2);
  const sourceEnds = await wc.executeJavaScript('ends');
  assert.deepEqual(sourceEnds, [{ trusted: true, dropEffect: 'copy' }, { trusted: true, dropEffect: 'none' }, { trusted: true, dropEffect: 'copy' }]);
  assert.equal(await wc.executeJavaScript('dragActive'), false); evidence.sourceEnds = sourceEnds;
  assert(session.isAttached); mark('fresh explicit drag succeeds after cancellation and rejection; shared inspector remains attached');
})().catch(async error => { evidence.error = String(error.stack || error); console.error(error); if(win&&!win.isDestroyed()) { evidence.page = await win.webContents.executeJavaScript('({receipts:window.receipts,mouse:window.mouse,payload:window.payload})'); console.log(evidence.page); } process.exitCode = 1; }).finally(() => {
  clearTimeout(guard); win?.destroy(); const dir = join(process.cwd(), 'out/diagnostics/browser-p0p1'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'html-drag.json'), JSON.stringify(evidence, null, 2)); app.exit(process.exitCode ? 1 : 0);
});


