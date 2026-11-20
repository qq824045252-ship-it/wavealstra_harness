const { run } = require('./desktop-dev-harness.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { PDFDocument } = require('@cantoo/pdf-lib');
const results = [];
const tools = ['drawio_reference', 'drawio_shapes', 'drawio_create', 'drawio_read', 'drawio_edit', 'drawio_layout', 'drawio_export', 'drawio_link'];
const native = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="R&D" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell><mxCell id="b" value="Review" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell><mxCell id="ab" source="a" target="b" edge="1" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>';
const operations = [
  ['drawio_reference', {name: 'mermaid'}],
  ['drawio_shapes', {queries: ['aws4 lambda']}],
  ['drawio_create', {path: 'login.drawio', mermaid: 'flowchart TD\n A[Start] --> B{Review}\n B --> C[Done]'}],
  ['drawio_read', {path: 'login.drawio'}],
  ['drawio_edit', () => ({source: 'login.drawio', path: 'edited.drawio', revision: results[3].revision, edits: [{operation:'add', xml:'<mxCell id="manual-note" value="Follow up" vertex="1" parent="1"><mxGeometry x="320" y="100" width="90" height="38" as="geometry"/></mxCell>'}]})],
  ['drawio_create', {path: 'layout.drawio', xml: native, layout: 'verticalFlow'}],
  ['drawio_layout', {source: 'layout.drawio', path: 'routed.drawio', layout: 'libavoid'}],
  ...['png','svg','pdf'].map(format => ['drawio_export', {source:'edited.drawio', path:'edited.drawio.'+format, format}]),
  ['drawio_link', {path:'login.drawio'}],
  ['drawio_create', {path:'static.drawio', mermaid:'flowchart TD\n A[Start] --> B[Done]', mermaidImage:true}],
  ...['png','svg','pdf'].map(format => ['drawio_create', {source:'edited.drawio.'+format, path:'reopened-'+format+'.drawio'}]),
];
run(async ({evaluate, rpc, until, home, report}) => {
  const workspace = path.join(home, 'drawio-workspace');
  fs.mkdirSync(workspace);
  const task = {id:'drawio-smoke', spaceId:'drawio-space', title:'Draw.io smoke', updatedAt:Date.now(), cwd:workspace, status:'idle', welcomeMode:'working', executionBackend:'pi', messages:[]};
  const space = {id:task.spaceId, name:'Draw.io validation', path:workspace, createdAt:Date.now(), updatedAt:Date.now()};
  await evaluate(`(async () => {
    const {useAppStore:store}=await import('/src/store/appStore.ts');
    const task=${JSON.stringify(task)}, space=${JSON.stringify(space)};
    await window.api.db.upsertSpace(space); await window.api.db.upsertTask(task);
    store.setState({page:'chat', activeTaskId:task.id, tasks:[task], spaces:[space], activeModelId:store.getState().models[0].id,
      panelOpen:true, panelMode:'overview', panelExpanded:true, draft:null});
    window.drawioStore=store;
  })()`);
  const request = {taskId:task.id, spaceId:space.id, modelId:'fixture/ui-fixture', text:'DRAWIO_NATIVE_SMOKE', welcomeMode:'working',
    userMessageId:'drawio-fixture-user', assistantMessageId:'drawio-fixture-assistant'};
  const completed = await evaluate(`window.api.agent.prompt(${JSON.stringify(request)}).then(x=>x.receipt?window.api.agent.waitForSubmission(x.receipt):x)`);
  assert.equal(completed.error, undefined, JSON.stringify(completed));
  assert.equal(results.length, operations.length);
  assert(results[3].cells.some(cell => cell.vertex && cell.value.includes('Review')));
  assert(results[3].cells.some(cell => cell.edge));
  assert(results[5].repairs.length > 0);
  assert.match(results.find(result => result.url)?.url, /^https:\/\/app\.diagrams\.net\/[^#]+#R/);
  const bytes = f => fs.readFileSync(path.join(workspace, f));
  assert.match(bytes('edited.drawio').toString(), /Follow up/);
  assert.match(bytes('layout.drawio').toString(), /value="R&amp;D"/);
  assert.match(bytes('routed.drawio').toString(), /edgeStyle=orthogonalEdgeStyle/);
  assert.equal(bytes('edited.drawio.png').readUInt32BE(0), 0x89504e47);
  assert.match(bytes('edited.drawio.png').toString('latin1'), /mxGraphModel/);
  assert.match(bytes('edited.drawio.svg').toString(), /content=".*Follow up/s);
  const pdf = await PDFDocument.load(bytes('edited.drawio.pdf'));
  assert.match(decodeURIComponent(pdf.getSubject()), /Follow up/);
  assert.match(bytes('static.drawio').toString(), /shape=image;/);
  for (const format of ['png','svg','pdf']) assert.match(bytes('reopened-'+format+'.drawio').toString(), /Follow up/);
  report.checks.push('The real task tool dispatcher exposed all 8 native tools and the official bundled skill, converted Mermaid to cells, repaired and laid out XML, routed edges, saved an edited copy, exported 3 editable formats and generated the share link.');
  await evaluate(`window.drawioStore.getState().hydrateArtifacts(${JSON.stringify(task.id)})`);
  await evaluate(`window.drawioStore.getState().openArtifact(${JSON.stringify(results[4].artifactId)})`);
  let target;
  await until(async () => {
    target = (await rpc('Target.getTargets')).targetInfos.find(info => /\/session\/[\w-]+\/$/.test(info.url));
    return Boolean(target);
  }, 'Draw.io WebContentsView');
  const {sessionId} = await rpc('Target.attachToTarget', {targetId:target.targetId,flatten:true});
  const view = async expression => {
    const r = await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i=0;i<40;i++) {
    if (await view("document.querySelector('#canvas')?.contentDocument?.querySelector('.geDiagramContainer')?.textContent.includes('Follow up')")) break;
    if (i===39) throw Error(JSON.stringify(await view("({status:document.querySelector('#status')?.textContent, inner:document.querySelector('#canvas')?.contentDocument?.body?.innerText.slice(0,500), resources:document.querySelector('#canvas')?.contentWindow?.performance.getEntriesByType('resource').filter(e=>e.responseStatus>=400).map(e=>e.name).slice(0,15)})")));
    await new Promise(r=>setTimeout(r,250));
  }
  const label = 'Saved from the embedded editor';
  const changed = bytes('edited.drawio').toString('utf8').replace('Follow up', label);
  const merge = JSON.stringify({ action: 'merge', xml: changed });
  await view(`document.querySelector('#canvas').contentWindow.postMessage(${JSON.stringify(merge)}, location.origin)`);
  const deadline = Date.now() + 10_000;
  await until(async () => {
    const text = await view("document.querySelector('#canvas').contentDocument.querySelector('.geDiagramContainer').textContent");
    if (text.includes(label)) return true;
    if (Date.now() > deadline) throw Error('The embedded editor did not apply the label change: ' + text);
    return false;
  }, 'Draw.io cell update');
  const saved = await view(`(() => {
    const frame = document.querySelector('#canvas');
    const button = [...frame.contentDocument.querySelectorAll('button')]
      .find(node => ['保存', 'Save'].includes(node.textContent.trim()));
    button?.click();
    return Boolean(button);
  })()`);
  assert(saved, 'Draw.io exposes its native save button');
  await until(() => {
    const file = bytes('edited.drawio').toString('utf8');
    const page = /<diagram\b[^>]*>([A-Za-z0-9+/=]+)<\/diagram>/.exec(file)?.[1];
    const xml = page ? decodeURIComponent(inflateRawSync(Buffer.from(page, 'base64')).toString('utf8')) : file;
    if (xml.includes(label)) return true;
    if (Date.now() > deadline + 10_000) throw Error('The embedded editor did not save the updated label');
    return false;
  }, 'embedded Draw.io save');
  report.checks.push('The MyBuddy native artifact WebContentsView rendered the diagram, edited a cell and saved the source through the official editor.');
}, {
  name:'drawio-native-smoke', settings:{permissionMode:'default'}, watchRenderer:false, rpcTimeoutMs:130000,
  fixtureModel(request) {
    const message=request.messages.at(-1);
    const user=request.messages.findLast(item=>item.role==='user');
    if (!JSON.stringify(user?.content).includes('DRAWIO_NATIVE_SMOKE')) return 'Ready';
    const names=request.tools?.map(entry=>entry.function.name)??[];
    assert(tools.every(name=>names.includes(name)));
    assert.match(request.messages.filter(item=>item.role==='system').map(item=>JSON.stringify(item.content)).join('\n'), /drawio-use[/\\]+SKILL\.md/);
    const step=request.messages.slice(request.messages.lastIndexOf(user)+1).filter(item=>item.role==='tool').length;
    if (step) {
      let details;
      try { details=JSON.parse(message.content); }
      catch { throw Error(operations[step-1][0]+': '+message.content); }
      if (details.error) throw Error(operations[step-1][0]+': '+details.error);
      results[step-1]=details;
      console.log('Draw.io smoke passed',operations[step-1][0],details.format??'');
    }
    if (step===operations.length) return '已核对';
    const [name,args]=operations[step];
    return {tool:{name,arguments:typeof args==='function'?args():args}};
  }
}).catch(e=>{ console.error(e); process.exitCode=1; });
