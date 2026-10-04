const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');process.chdir(root);
if(!process.versions.electron){
  require('esbuild').buildSync({entryPoints:['scripts/remote-renderer-regression-fixture.tsx'],bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:'out/remote-tests/fixture.js',define:{'process.env.NODE_ENV':'"production"'}});
  fs.writeFileSync('out/remote-tests/index.html','<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const r=spawnSync(require('electron'),[__filename,'--fixture'],{encoding:'utf8',env,timeout:55000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)console.error(r.error);process.exit(r.status??1);
}
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(root,'out/remote-tests/profile'));
const results=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));
let win;
async function evaluate(expr){return win.webContents.executeJavaScript(expr,true)}
async function until(expr,timeout=5000){const started=Date.now();while(Date.now()-started<timeout){if(await evaluate(expr))return;await delay(50)}throw Error('Timed out: '+expr)}
function pass(name){results.push({name,ok:true});console.log('PASS '+name)}
app.whenReady().then(async()=>{
  win=new BrowserWindow({width:412,height:915,useContentSize:true,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(path.join(root,'out/remote-tests/index.html'));
  await until('!!document.querySelector(".message-bubble-user")');
  await evaluate('window.remoteFixture.svgReply()');
  await until('document.querySelector(".md-svg-image")?.naturalWidth > 0');
  pass('fenced SVG uses desktop renderer and decodes as a real image');
  assert.equal(await evaluate('document.querySelector(".md-svg-image").closest("pre")===null'),true);
  pass('SVG is outside pre/code; no invalid nested block wrapper');
  assert.equal(await evaluate('document.querySelector(".process-panel-header").getAttribute("aria-expanded")'), 'false');
  await evaluate('window.remoteFixture.toolStart()');await delay(100);
  assert.equal(await evaluate('document.querySelector(".process-panel-header").getAttribute("aria-expanded")'),'false');
  pass('new thinking and running tools do not auto-expand process panel');
  await evaluate('document.querySelector(".process-panel-header").click()');await delay(100);
  assert.equal(await evaluate('document.querySelector(".tool-card-header").getAttribute("aria-expanded")'),'false');
  await evaluate('window.remoteFixture.toolUpdate()');await delay(100);
  assert.equal(await evaluate('document.querySelector(".tool-card-header").getAttribute("aria-expanded")'),'false');
  pass('tool details stay folded through running-to-success updates');
  await evaluate('document.querySelector(".tool-card-header").click()');await delay(100);
  assert.equal(await evaluate('document.querySelector(".tool-console-output").textContent'),'ACTUAL_TOOL_OUTPUT');
  pass('explicit expansion shows output, not mislabeled call arguments');
  await evaluate('document.querySelector(".process-panel-header").click()');await delay(100);
  const order=await evaluate(`(()=>{const nodes=[...document.querySelectorAll('.chat-timeline > [data-message-id]')];const user=nodes.findIndex(n=>n.dataset.messageId==='current-user');const reply=nodes.findIndex(n=>n.textContent.includes('BEFORE_SVG'));return {user,reply,overlap:nodes.some((n,i)=>i>0&&n.offsetTop<nodes[i-1].offsetTop+nodes[i-1].offsetHeight-1)}})()`);
  assert.ok(order.reply>order.user);assert.equal(order.overlap,false);
  pass('user precedes answer; intrinsic row heights prevent overlap and reversed-looking content');
  await evaluate(`(()=>{const e=document.querySelector('.chat-timeline');e.scrollTop=Math.max(0,e.scrollTop-500);e.dispatchEvent(new Event('scroll'));})()`);await delay(100);
  const before=await evaluate('document.querySelector(".chat-timeline").scrollTop');
  await evaluate('window.remoteFixture.tail()');await delay(150);
  const after=await evaluate('document.querySelector(".chat-timeline").scrollTop');
  assert.ok(Math.abs(before-after)<2,JSON.stringify({before,after}));
  pass('streamed replies do not steal historical reading scroll position');
  for(const width of [360,412]){
    win.setContentSize(width,800);await delay(100);
    const bounds=await evaluate(`(()=>{const t=document.querySelector('.chat-timeline');return {width:t.clientWidth,scroll:t.scrollWidth,negative:[...t.children].some(x=>x.getBoundingClientRect().height<0)}})()`);
    assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify(bounds));pass('no horizontal overflow at '+width+' CSS px');
  }
  await evaluate('window.remoteFixture.tableHistory()');await until('document.querySelectorAll(".markdown-table-scroll").length===2');
  win.setContentSize(360,800);await delay(100);
  const tableLayout=await evaluate(`(()=>{const timeline=document.querySelector('.chat-timeline');const wraps=[...document.querySelectorAll('.markdown-table-scroll')];return {
    timeline:{client:timeline.clientWidth,scroll:timeline.scrollWidth},
    tables:wraps.map(w=>{const table=w.querySelector('table');const th=table.querySelector('th');const shell=w.parentElement;const cell=getComputedStyle(th);return {client:w.clientWidth,scroll:w.scrollWidth,table:table.getBoundingClientRect().width,paddingLeft:parseFloat(cell.paddingLeft),headerBg:cell.backgroundColor,borderBottom:parseFloat(cell.borderBottomWidth),radius:getComputedStyle(shell).borderRadius}})
  }})()`);
  assert.equal(tableLayout.tables.length,2);
  assert.ok(tableLayout.timeline.scroll<=tableLayout.timeline.client+1,JSON.stringify(tableLayout));
  assert.ok(tableLayout.tables[0].scroll<=tableLayout.tables[0].client+1,'3-column table should fit without needless horizontal scroll: '+JSON.stringify(tableLayout.tables[0]));
  assert.ok(tableLayout.tables[1].scroll>tableLayout.tables[1].client+80,'wide table should own horizontal overflow: '+JSON.stringify(tableLayout.tables[1]));
  assert.ok(tableLayout.tables.every(t=>t.paddingLeft>=8&&t.borderBottom>0&&t.radius!=='0px'&&t.headerBg!=='rgba(0, 0, 0, 0)'),JSON.stringify(tableLayout));
  assert.equal(await evaluate(`(()=>{const w=document.querySelectorAll('.markdown-table-scroll')[1];w.scrollLeft=80;return w.scrollLeft>0})()`),true);
  pass('mobile tables have bordered readable cells; compact tables fit and wide tables scroll locally');
  await evaluate('window.remoteFixture.svgReply()');
  await until('document.querySelector(".md-svg-image")?.naturalWidth > 0');
  await evaluate('window.remoteFixture.rawSvg()');
  await until('document.querySelectorAll(".md-svg-image").length===2 && [...document.querySelectorAll(".md-svg-image")].every(i=>i.naturalWidth>0)');
  pass('standalone raw SVG renders through the same safe preview path');
  await evaluate('window.remoteFixture.failSvg()');await delay(100);
  assert.equal(await evaluate('!!document.querySelector(".md-svg-error") && !window.bad'),true);
  pass('executable SVG is blocked without injecting markup into the page');
  await evaluate('window.dispatchEvent(new Event("online"))');await delay(50);
  assert.ok((await evaluate('window.remoteFixture.counters()')).resumes>=1);
  pass('network restoration triggers foreground resume synchronization');
  // Reproduce the actual SSH thread: decoded historical SVGs ABOVE a reader near
  // the bottom. A mid-page text-only test cannot detect browser scroll clamping.
  await evaluate('window.remoteFixture.longSvgHistory()');
  await until('document.querySelectorAll(".md-svg-image").length === 7 && [...document.querySelectorAll(".md-svg-image")].every(i => i.complete && i.naturalWidth > 0)');
  await evaluate('window.remoteFixture.svgReply()');
  await until('document.querySelectorAll(".md-svg-image").length === 8 && [...document.querySelectorAll(".md-svg-image")].every(i => i.complete && i.naturalWidth > 0)');
  await delay(100);
  await evaluate(`(() => {
    const el = document.querySelector('.chat-timeline');
    el.scrollTop = el.scrollHeight - el.clientHeight - 4;
    window.svgScrollRegression = {
      elements: [...document.querySelectorAll('.md-svg-image')],
      y: el.scrollTop, height: el.scrollHeight, minHeight: el.scrollHeight, maxDrift: 0,
    };
    const state = window.svgScrollRegression;
    state.observer = new MutationObserver(() => {
      state.minHeight = Math.min(state.minHeight, el.scrollHeight);
      state.maxDrift = Math.max(state.maxDrift, Math.abs(el.scrollTop - state.y));
    });
    state.observer.observe(el, { childList: true, subtree: true });
  })()`);
  for (let i = 0; i < 5; i++) {
    await evaluate('window.remoteFixture.refreshUnchanged()');
    await delay(150);
  }
  const stable = await evaluate(`(() => {
    const state = window.svgScrollRegression;
    const images = [...document.querySelectorAll('.md-svg-image')];
    const el = document.querySelector('.chat-timeline');
    return { sameImages: images.length === state.elements.length && images.every((n,i) => n === state.elements[i]),
      heightLost: state.height - state.minHeight, drift: Math.max(state.maxDrift, Math.abs(el.scrollTop - state.y)) };
  })()`);
  assert.equal(stable.sameImages, true, 'Unchanged snapshots must not remount SVG previews: ' + JSON.stringify(stable));
  assert.ok(stable.heightLost < 2 && stable.drift < 2, 'Long thread is clamped away from bottom: ' + JSON.stringify(stable));
  pass('five unchanged snapshot refreshes preserve all 8 SVG DOM nodes and bottom reading position');
  for (let i = 0; i < 3; i++) {
    await evaluate('window.remoteFixture.tail()');
    await delay(100);
  }
  assert.equal(await evaluate('window.svgScrollRegression.elements.every((n,i) => n === document.querySelectorAll(".md-svg-image")[i])'), true);
  pass('streamed text after SVG keeps historical and same-reply previews mounted');
  await evaluate('window.svgScrollRegression.observer.disconnect()');
  // Preview/source choice is component state, not disposable snapshot state.
  await evaluate(`[...document.querySelector('.md-svg-card').querySelectorAll('button')].find(b => b.textContent === '源码').click()`);
  await delay(50);
  await evaluate('window.remoteFixture.refreshUnchanged()');await delay(100);
  assert.equal(await evaluate('!!document.querySelector(".md-svg-card .md-fence-source")'), true);
  pass('SVG source selection survives background snapshots');
  for (const mode of ['inline', 'forward', 'link', 'only']) {
    await evaluate('window.remoteFixture.raster(' + JSON.stringify(mode) + ')');
    await until('document.querySelector(".remote-artifact-image")?.naturalWidth > 0'); await delay(50);
    assert.equal(await evaluate('document.querySelectorAll(".remote-artifact-image").length'),1);
    assert.equal(await evaluate('window.rasterProbe.reads'),1);
    pass('raster ' + mode + ': registered PNG decodes once without inline/fallback duplicates');
  }
  await evaluate('window.oldRasterImage=document.querySelector(".remote-artifact-image");window.oldRasterUrl=window.oldRasterImage.src');
  for(let i=0;i<5;i++) { await evaluate('window.remoteFixture.rasterRefresh()'); await delay(60); }
  assert.equal(await evaluate('window.oldRasterImage===document.querySelector(".remote-artifact-image") && window.oldRasterUrl===window.oldRasterImage.src && window.rasterProbe.reads===1'),true);
  pass('raster DOM, decoded blob URL and network request survive five history refreshes');
  await evaluate('document.querySelector(".remote-image-open").click()'); await delay(80);
  assert.equal(await evaluate('!!document.querySelector(".remote-image-viewer[role=dialog]")'),true);
  assert.equal(await evaluate('document.querySelector(".remote-image-viewer img").src===window.oldRasterUrl'),true);
  await evaluate('document.querySelector("button[aria-label=关闭原图]").click()');await delay(50);
  pass('original-image viewer uses the same authenticated blob without another download');
  await evaluate('window.remoteFixture.rasterFailNext()');
  await until('!!document.querySelector(".remote-image-status button")');
  await evaluate('document.querySelector(".remote-image-status button").click()');
  await until('document.querySelector(".remote-artifact-image")?.naturalWidth > 0');
  assert.equal(await evaluate('window.rasterProbe.reads'),3);
  pass('failed version refresh offers a working retry without clearing chat or credentials');
  await evaluate('window.remoteFixture.raster("unknown")');await delay(80);
  assert.equal(await evaluate('document.querySelectorAll(".remote-artifact-image").length'),0);
  assert.equal(await evaluate('window.rasterProbe.reads'),0);
  assert.equal(await evaluate('!!document.querySelector(".remote-image-status")'),true);
  pass('unregistered local image stays blocked and does not trigger arbitrary file reads');

  fs.mkdirSync('artifacts/pi0992-memory/android/renderer',{recursive:true});
  fs.writeFileSync('artifacts/pi0992-memory/android/renderer/renderer-results.json',JSON.stringify({ok:true,passed:results.length,results},null,2));
  fs.writeFileSync('artifacts/pi0992-memory/android/renderer/renderer.png',(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ok:true,passed:results.length}));win.destroy();app.exit(0);
}).catch(error=>{console.error(error);fs.mkdirSync('artifacts/pi0992-memory/android/renderer',{recursive:true});fs.writeFileSync('artifacts/pi0992-memory/android/renderer/renderer-results.json',JSON.stringify({ok:false,error:String(error),results},null,2));app.exit(1)});
