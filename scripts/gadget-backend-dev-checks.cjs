/** Real visible dev app, actual Gadget IPC and native browser; synthetic isolated data only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

module.exports = async ({ evaluate, rpc, until, report, out, home }) => {
  const marker = 'browser-proof-' + Date.now();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Gadget backend checking</title>
    <style>body{font:22px system-ui;padding:40px;background:#f5f7fa;color:#142033}pre{white-space:pre-wrap}</style></head>
    <body><h1>Gadget backend real browser</h1><button id="run" style="font:inherit;padding:12px 24px">Run Node calculation</button><pre id="result">Running actual Node calculation…</pre>
    <script>
    async function calculate() {
      const previous = await window.gadget.storage.get('browser-proof');
      const result = await window.gadget.call('calculate', { values: [6, 7, 8] });
      const proof = { marker: ${JSON.stringify(marker)}, require: typeof require,
        nodeResult: result, url: location.href, visits: (previous?.visits || 0) + 1,
        previousMarker: previous?.marker || null, userAgent: navigator.userAgent };
      await window.gadget.storage.set('browser-proof', proof);
      document.getElementById('result').textContent = JSON.stringify(proof, null, 2);
      document.title = 'Gadget backend PASS ' + result.total;
    }
    async function run() { try { await calculate(); } catch(error) {
      document.title = 'Gadget backend FAILED';
      document.getElementById('result').textContent = String(error.stack || error);
      if (window.gadget) await window.gadget.storage.set('browser-error', String(error.stack || error));
    } }
    document.getElementById('run').addEventListener('click', run);
    void run();
    </script></body></html>`;
  const backend = `export default function createBackend() {
    return { actions: { async calculate(input, ctx) {
      const result = await ctx.exec('node', { args: ['-e',
        'const input=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({total:input.values.reduce((a,b)=>a+b,0),runtime:process.release.name,node:process.versions.node}))',
        JSON.stringify(input)] });
      if (result.exitCode !== 0) throw new Error('Node calculation failed');
      return JSON.parse(result.stdout);
    } } };
  }`;
  const request = {
    name: 'Real backend calculation', scope: { type: 'global' },
    files: [{ path: 'index.html', content: html }, { path: 'server/index.mjs', content: backend }],
    backend: { entry: 'server/index.mjs', commands: ['node'] },
  };
  const workspace = path.join(home, 'backend-workspace');
  fs.mkdirSync(workspace);
  const item = await evaluate(`(async()=>{
    const {useAppStore:s}=await import('/src/store/appStore.ts');
    const space={id:'backend-dev-space',name:'Backend dev',path:${JSON.stringify(workspace)},createdAt:Date.now(),updatedAt:Date.now()};
    const task={id:'backend-dev-task',title:'Backend browser acceptance',spaceId:space.id,updatedAt:Date.now(),modelId:'fixture/ui-fixture',welcomeMode:'working',messages:[]};
    await window.api.db.upsertSpace(space);await window.api.db.upsertTask(task);
    s.setState({theme:'light',page:'chat',tasks:[task],spaces:[space],activeTaskId:task.id,draft:null,sidebarCollapsed:true,panelOpen:false});
    return window.api.gadget.create(${JSON.stringify(request)});
  })()`);
  const source = await evaluate(`window.api.gadget.readSource(${JSON.stringify(item.id)})`);
  assert.equal(source.manifest.backend.entry, 'server/index.mjs', 'actual create IPC retains backend declaration');
  assert.deepEqual(source.manifest.backend.commands, ['node']);
  report.seededPresentationFacts.push('Actual IPC created an isolated global Gadget with local HTML and Node backend; no model or external account involved.');
  const open = async runtime => evaluate(`(async()=>{
    const {openGadgetBrowser}=await import('/src/lib/gadgetBrowser.ts');
    openGadgetBrowser(${JSON.stringify(item.id)},${JSON.stringify(runtime.url)});
  })()`);
  // This VM only observes storage. The real native browser is the sole caller of calculate.
  const observer = async url => {
    const response = await fetch(new URL('__mybuddy/sdk.js', url), { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const context = { window: {}, location: { origin: new URL(url).origin },
      document: { addEventListener() {} }, fetch, AbortController, AbortSignal };
    vm.runInNewContext(await response.text(), context, { timeout: 1000 });
    return context.window.gadget;
  };
  const proofAt = async (runtime, minVisits) => {
    const client = await observer(runtime.url);
    let proof;
    await until(async () => {
      const error = await client.storage.get('browser-error');
      if (error) throw new Error('Native browser failed: ' + error);
      proof = await client.storage.get('browser-proof');
      return proof?.marker === marker && proof.url === runtime.url && proof.visits >= minVisits;
    }, 'native browser SDK -> backend -> actual Node -> durable proof');
    assert.equal(proof.require, 'undefined', 'native renderer has no Node require');
    assert.equal(proof.nodeResult.total, 21);
    assert.equal(proof.nodeResult.runtime, 'node');
    assert.match(proof.nodeResult.node, /^\d+\./);
    let targets;
    await until(async () => {
      targets = (await rpc('Target.getTargets')).targetInfos;
      return targets.some(target => target.url === runtime.url && target.title === 'Gadget backend PASS 21');
    }, 'real browser document displays calculation result');
    report.checks.push({ label: 'native-browser-backend', proof, target: targets.find(target => target.url === runtime.url) });
    return proof;
  };
  const runtime = await evaluate(`window.api.gadget.start(${JSON.stringify(item.id)})`);
  assert.equal(runtime.status, 'running');
  await open(runtime);
  const first = await proofAt(runtime, 1);
  const nativeTarget = (await rpc('Target.getTargets')).targetInfos.find(target => target.url === runtime.url);
  assert(nativeTarget, 'native browser target exists');
  const { sessionId } = await rpc('Target.attachToTarget', { targetId: nativeTarget.targetId, flatten: true });
  const nativeEvaluate = async expression => {
    const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  let clicked;
  try {
    await rpc('Page.enable', {}, sessionId);
    const beforeClick = await nativeEvaluate(`({title:document.title,text:document.querySelector('#result').textContent,require:typeof require})`);
    assert.equal(beforeClick.require, 'undefined');
    assert.equal(JSON.parse(beforeClick.text).nodeResult.total, 21);
    const point = await nativeEvaluate(`(()=>{const button=document.querySelector('#run');button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!button.contains(document.elementFromPoint(x,y)))throw Error('Run button is obscured');return {x,y};})()`);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId);
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId);
    clicked = await proofAt(runtime, first.visits + 1);
    await until(async () => {
      const text = await nativeEvaluate(`document.querySelector('#result').textContent`);
      return JSON.parse(text).visits >= clicked.visits;
    }, 'native button result rendered');
    fs.writeFileSync(path.join(out, 'backend-browser-native.png'), Buffer.from((await rpc('Page.captureScreenshot', { format: 'png' }, sessionId)).data, 'base64'));
    report.checks.push({ label: 'native-input-and-visible-result', beforeClick, point,
      afterClick: await nativeEvaluate(`({title:document.title,text:document.querySelector('#result').textContent})`), screenshot: 'backend-browser-native.png' });
  } finally {
    await rpc('Target.detachFromTarget', { sessionId });
  }
  const tabs = await evaluate('window.api.browser.getTabs()');
  assert(tabs.tabs.some(tab => tab.gadgetId === item.id && tab.url === runtime.url), 'actual built-in browser retains Gadget identity');
  fs.writeFileSync(path.join(out, 'backend-browser-app.png'), Buffer.from((await rpc('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const restarted = await evaluate(`window.api.gadget.restart(${JSON.stringify(item.id)})`);
  assert.equal(restarted.status, 'running');
  assert.notEqual(restarted.url, runtime.url, 'restart obtains a fresh endpoint');
  const persisted = await (await observer(restarted.url)).storage.get('browser-proof');
  assert.equal(persisted.marker, marker, 'browser-written state survives backend restart');
  assert.equal(persisted.nodeResult.total, 21);
  await open(restarted);
  const second = await proofAt(restarted, clicked.visits + 1);
  assert.equal(second.previousMarker, marker);
  const health = await evaluate(`window.api.gadget.health(${JSON.stringify(item.id)})`);
  assert.equal(health.status, 'running');
  assert.equal(health.url, restarted.url);
  report.checks.push({ label: 'restart-persistence-health', before: runtime, after: restarted, health });
  report.actualControlChecks.push('Actual renderer IPC creates and starts Gadget; openGadgetBrowser opens native browser; native CDP mouse input clicks Run Node calculation; backend executes real Node and renders 21; restart preserves state and page runs again.');
  report.screenshotEvidence = 'backend-browser-native.png captures the actual native WebContentsView through its attached CDP target. Main renderer screenshot is supplementary. The VM observer only reads storage and never invokes calculate.';
};
