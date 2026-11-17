const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');

const output = join(process.cwd(), 'out/tests/browser-document-context');
mkdirSync(output, { recursive: true });
buildSync({ entryPoints: ['src/main/capabilities/browser/BrowserDocumentContext.ts', 'src/main/capabilities/AutomationScope.ts'],
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outdir: output, logLevel: 'silent' });
const { bindBrowserDocument, listBrowserFrames, BrowserDocumentContextError } = require(join(output, 'browser/BrowserDocumentContext.js'));
const { AutomationScope } = require(join(output, 'AutomationScope.js'));
const profile = mkdtempSync(join(tmpdir(), 'mybuddy-frame-context-'));
app.setPath('userData', join(profile, 'profile'));
app.setPath('home', profile);
app.on('window-all-closed', () => {});
const servers = [];
let window;
const checks = [];
const evidence = { electron: process.versions.electron, checks };
const mark = value => { checks.push(value); console.log('PASS', value); };
async function serve(host, handler) {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(handler(req)); });
  servers.push(server);
  await new Promise(resolve => server.listen(0, host, resolve));
  return `http://${host}:${server.address().port}`;
}
const guard = setTimeout(() => { console.error('frame context test timed out'); app.exit(1); }, 45000);
(async () => {
  await app.whenReady();
  let first;
  const second = await serve('127.0.0.2', () => `<body style="margin:0"><div style="height:550px">Cross origin</div><div id="host"></div><script>host.attachShadow({mode:'open'}).innerHTML='<iframe name="nested" style="width:350px;height:220px;border:6px solid;padding:3px;transform:scale(.85);transform-origin:top left" src="${first}/nested"></iframe>'</script></body>`);
  first = await serve('127.0.0.1', req => req.url === '/nested'
    ? '<body style="margin:0"><button id="target" style="margin:25px;width:120px;height:50px" onclick="window.clicks=(window.clicks||0)+1;window.trusted=event.isTrusted">Nested save</button><input id="field" aria-label="备注" oninput="window.typedTrusted=event.isTrusted"></body>'
    : `<body style="margin:0"><div style="height:900px">Top</div><div id="host"></div><iframe name="sibling" src="${first}/nested"></iframe><script>host.attachShadow({mode:'open'}).innerHTML='<iframe name="cross" style="width:600px;height:500px;border:8px solid;padding:5px;transform:scale(.8);transform-origin:top left" src="${second}"></iframe>'</script></body>`);
  window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { sandbox: true, backgroundThrottling: false } });
  const wc = window.webContents;
  window.showInactive();
  await wc.loadURL(first);
  const frames = listBrowserFrames(wc);
  const nested = frames.find(frame => frame.name === 'nested');
  const sibling = frames.find(frame => frame.name === 'sibling');
  assert(nested && sibling);
  assert.equal(nested.url, sibling.url);
  assert.notEqual(nested.frameId, sibling.frameId);
  const scope = new AutomationScope(undefined, 15000);
  const context = await bindBrowserDocument(wc, nested.frameId, '__frameContextTest', scope);
  assert.notEqual(context.nativeFrame.parent.processId, wc.mainFrame.processId, 'middle frame must actually use another process');
  assert.equal(await context.evaluate('document.querySelector("#target").textContent'), 'Nested save');
  mark('native nested cross-origin frame resolved despite duplicate URL sibling');
  await context.prepare();
  const local = await context.evaluate('(()=>{const r=document.querySelector("#target").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  const point = await context.mapPoint(local);
  evidence.point = point;
  evidence.local = local;
  for (const frame of wc.mainFrame.framesInSubtree) await frame.executeJavaScript('window.pointerEvents=[];document.addEventListener("mousedown",event=>pointerEvents.push({x:event.clientX,y:event.clientY,target:event.target.tagName,id:event.target.id}),true)');
  await wc.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  evidence.pointerEvents = await Promise.all(wc.mainFrame.framesInSubtree.map(async frame => ({name:frame.name,events:await frame.executeJavaScript('pointerEvents'),viewport:await frame.executeJavaScript('({width:innerWidth,height:innerHeight,scrollX,scrollY})')})));
  assert.deepEqual(await context.evaluate('({clicks:window.clicks,trusted:window.trusted})'), { clicks: 1, trusted: true });
  const siblingContext = await bindBrowserDocument(wc, sibling.frameId, '__frameContextTest', scope);
  assert.equal(await siblingContext.evaluate('window.clicks||0'), 0);
  mark('trusted root CDP click reaches nested frame through open-shadow owners, padding, borders, scales and ancestor scrolling');
  await context.evaluate('document.querySelector("#field").focus()');
  await wc.debugger.sendCommand('Input.insertText', {text:'嵌套输入🙂'});
  assert.deepEqual(await context.evaluate('({value:document.querySelector("#field").value,trusted:window.typedTrusted})'), {value:'嵌套输入🙂',trusted:true});
  assert.equal(await siblingContext.evaluate('document.querySelector("#field").value'), '');
  mark('trusted CDP text input edits focused nested document without editing same-URL sibling');
  const runtimeContexts = new Map();
  const sessionJobs = new Map();
  const enable = sessionId => {
    if (sessionJobs.has(sessionId)) return sessionJobs.get(sessionId);
    const job = (async () => {
      await wc.debugger.sendCommand('Runtime.enable', {}, sessionId || undefined);
      await wc.debugger.sendCommand('Accessibility.enable', {}, sessionId || undefined);
      await wc.debugger.sendCommand('Target.setAutoAttach', {autoAttach:true,waitForDebuggerOnStart:false,flatten:true}, sessionId || undefined);
    })();
    sessionJobs.set(sessionId, job);
    return job;
  };
  wc.debugger.on('message', (_event, method, params, sessionId) => {
    if(method==='Target.attachedToTarget') void enable(params.sessionId).catch(()=>{});
    if(method==='Runtime.executionContextCreated'&&params.context.auxData?.isDefault) runtimeContexts.set(`${sessionId||''}:${params.context.id}`, {sessionId:sessionId||'',context:params.context});
  });
  await enable('');
  let mappedContext;
  const contextDeadline=Date.now()+3000;
  while(!mappedContext&&Date.now()<contextDeadline){
    await Promise.all([...sessionJobs.values()]);
    for(const entry of runtimeContexts.values()){
      const result=await wc.debugger.sendCommand('Runtime.evaluate',{expression:'window.__frameContextTest?.documentId',contextId:entry.context.id,returnByValue:true},entry.sessionId||undefined);
      if(result.result.value===context.identity.documentId){assert(!mappedContext,'document nonce must map uniquely');mappedContext=entry;}
    }
    if(!mappedContext)await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert(mappedContext,'recursive native child session maps exact document nonce');
  const ax=await wc.debugger.sendCommand('Accessibility.getFullAXTree',{frameId:mappedContext.context.auxData.frameId},mappedContext.sessionId||undefined);
  assert(ax.nodes.some(node=>node.role?.value==='button'&&node.name?.value==='Nested save'&&node.backendDOMNodeId));
  evidence.contextMapping={sessionId:mappedContext.sessionId,contextId:mappedContext.context.id,cdpFrameId:mappedContext.context.auxData.frameId,documentId:context.identity.documentId,button:ax.nodes.find(node=>node.role?.value==='button'&&node.name?.value==='Nested save')};
  mark('recursive shared debugger sessions correlate native document nonce to exact CDP frame and Chromium AX button');
  await wc.executeJavaScript('document.querySelector("#host").shadowRoot.querySelector("iframe").style.transform="rotate(3deg)"');
  await assert.rejects(context.mapPoint(local), error => error instanceof BrowserDocumentContextError && error.code === 'UNSUPPORTED_SCOPE');
  mark('rotated ancestor geometry rejected');
  await wc.executeJavaScript('document.querySelector("#host").shadowRoot.querySelector("iframe").style.transform="scale(.8)";const cover=document.createElement("div");cover.id="cover";cover.style="position:fixed;inset:0;z-index:999;background:white";document.body.append(cover)');
  await assert.rejects(context.mapPoint(local), error => error instanceof BrowserDocumentContextError && error.code === 'UNSUPPORTED_SCOPE');
  await wc.executeJavaScript('document.querySelector("#cover").remove()');
  mark('ancestor occlusion rejected');
  const abort = new AbortController();
  const cancelled = await bindBrowserDocument(wc, nested.frameId, '__frameContextTest', new AutomationScope(abort.signal, 3000));
  const pending = cancelled.evaluate('new Promise(resolve=>setTimeout(()=>resolve(true),200))');
  abort.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await assert.rejects(cancelled.mapPoint(local), error => error.name === 'AbortError');
  mark('cancelled evaluation cannot proceed to mapped input');
  await assert.rejects(bindBrowserDocument(wc, 'wrong-tab-frame', '__frameContextTest', scope), error => error.code === 'PAGE_UNAVAILABLE');
  mark('unknown frame identity rejected');
  const targetFrame = context.nativeFrame;
  const loaded = new Promise(resolve => targetFrame.once('dom-ready', resolve));
  targetFrame.reload(); await loaded;
  assert.throws(() => context.validate(), error => error.code === 'SURFACE_CHANGED');
  await assert.rejects(context.evaluate('true'), error => error.code === 'SURFACE_CHANGED');
  mark('same-URL reload rejects previous document reference');
  const newFrame = listBrowserFrames(wc).find(frame => frame.name === 'nested');
  const fresh = await bindBrowserDocument(wc, newFrame.frameId, '__frameContextTest', scope);
  assert.notEqual(fresh.identity.documentId, context.identity.documentId);
  context.dispose(); context.dispose();
  assert.equal(await wc.executeJavaScript('window.__frameContextTest.frameOwners.size'), 0);
  assert.throws(()=>context.validate(), error => error.code==='SURFACE_CHANGED');
  mark('idempotent context disposal releases its owner entries and blocks reuse');
  await wc.mainFrame.framesInSubtree.find(frame => frame.name === 'cross').executeJavaScript('document.querySelector("#host").shadowRoot.querySelector("iframe").remove()');
  assert.throws(() => fresh.validate(), error => error.code === 'SURFACE_CHANGED');
  mark('removed native frame invalidates retained context');
  fresh.dispose(); siblingContext.dispose(); cancelled.dispose();
})().catch(error => { evidence.error = String(error.stack || error); console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(guard);
  const directory = join(process.cwd(), 'out/diagnostics/browser-p0p1');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'document-context.json'), JSON.stringify(evidence, null, 2));
  window?.destroy(); servers.forEach(server => server.close()); app.exit(process.exitCode ? 1 : 0);
});
