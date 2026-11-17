const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const profile = mkdtempSync(join(tmpdir(), 'mybuddy-browser-engine-probe-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
let main;
const servers = [];
const evidence = { electron: process.versions.electron, frames: [], protocol: {}, events: [] };
async function serve(host, body) {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(body(req)); });
  servers.push(server);
  await new Promise(resolve => server.listen(0, host, resolve));
  return `http://${host}:${server.address().port}`;
}
const watchdog = setTimeout(() => app.exit(1), 20000);
(async () => {
  await app.whenReady();
  let first;
  const second = await serve('127.0.0.2', () => `<body style="margin:0"><input id=field aria-label=Frame><iframe src="${first}/nested" style="position:absolute;left:20px;top:100px"></iframe></body>`);
  first = await serve('127.0.0.1', req => req.url === '/nested' ? '<button id=nested>Nested</button>' : `<body><iframe src="${second}" name="cross" style="margin:20px;border:4px solid;width:500px;height:350px"></iframe></body>`);
  main = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true } });
  const wc = main.webContents;
  wc.debugger.attach('1.3');
  wc.debugger.on('message', (_e, method, params, sessionId) => {
    if (method.startsWith('Target.')) evidence.events.push({ method, params, sessionId });
  });
  await wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await wc.loadURL(first);
  for (const frame of wc.mainFrame.framesInSubtree) {
    evidence.frames.push({ id: frame.frameTreeNodeId, token: frame.frameToken, processId: frame.processId, routingId: frame.routingId, name: frame.name, url: frame.url, parent: frame.parent?.frameTreeNodeId, result: await frame.executeJavaScript('({url:location.href,width:innerWidth,height:innerHeight})') });
  }
  const tree = await wc.debugger.sendCommand('Page.getFrameTree');
  evidence.protocol.tree = tree;
  evidence.protocol.owners = [];
  const visit = async node => {
    if (node.frame.parentId) {
      try {
        const owner = await wc.debugger.sendCommand('DOM.getFrameOwner', { frameId: node.frame.id });
        const box = await wc.debugger.sendCommand('DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
        evidence.protocol.owners.push({ frame: node.frame.id, owner, box });
      } catch (error) { evidence.protocol.owners.push({ frame: node.frame.id, error: String(error) }); }
    }
    for (const child of node.childFrames ?? []) await visit(child);
  };
  await visit(tree.frameTree);
  for (const event of evidence.events.filter(event => event.method === 'Target.attachedToTarget')) {
    try { evidence.protocol[event.params.sessionId] = await wc.debugger.sendCommand('Page.getFrameTree', {}, event.params.sessionId); }
    catch (error) { evidence.protocol[event.params.sessionId] = String(error); }
  }
  const output = join(process.cwd(), 'out/diagnostics/browser-p0p1');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'engine-probe.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog);
  main?.destroy();
  for (const server of servers) server.close();
  app.exit(process.exitCode ? 1 : 0);
});
