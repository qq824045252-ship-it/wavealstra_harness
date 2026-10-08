const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');process.chdir(root);
const artifactDir=process.env.REMOTE_RENDERER_ARTIFACT_DIR || 'artifacts/remote-android-20260930';
if(!process.versions.electron){
  require('esbuild').buildSync({entryPoints:['scripts/remote-renderer-regression-fixture.tsx'],bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:'out/remote-tests/fixture.js',define:{'process.env.NODE_ENV':'"production"'}});
  fs.writeFileSync('out/remote-tests/index.html','<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const r=spawnSync(require('electron'),[__filename,'--fixture'],{encoding:'utf8',env,timeout:55000,windowsHide:true});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)console.error(r.error);process.exit(r.status??1);
}
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(root,'out/remote-tests/profile'));
const results=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));
let win;
// Consume the offscreen compositor frame directly. capturePage() may reject with
// UnknownVizError on a newly opened hidden Windows surface before its first frame.
async function capture(){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{win.webContents.removeListener('paint',onPaint);reject(Error('Offscreen paint timeout'));},5000);function onPaint(_event,_rect,image){clearTimeout(timer);resolve(image);}win.webContents.once('paint',onPaint);win.webContents.invalidate();});}
async function evaluate(expr){return win.webContents.executeJavaScript(expr,true)}
async function until(expr,timeout=5000){const started=Date.now();while(Date.now()-started<timeout){if(await evaluate(expr))return;await delay(50)}throw Error('Timed out: '+expr)}
// A broken log pipe must reject the running test, not emit an uncaught stream error later.
function log(line){fs.writeSync(1,line+'\n')}
function pass(name){results.push({name,ok:true});log('PASS '+name)}
app.whenReady().then(async()=>{
  win=new BrowserWindow({width:412,height:915,useContentSize:true,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  win.webContents.setFrameRate(30);
  win.webContents.on('paint',()=>{});
  win.webContents.startPainting();
  await win.loadFile(path.join(root,'out/remote-tests/index.html'));
  await until('!!document.querySelector(".message-bubble-user")');
  await evaluate('window.remoteFixture.event("assistant_start")');
  await evaluate('window.remoteFixture.event("thinking_delta", {delta:"先检查事件链路。"})');
  await until('document.querySelector(".process-thinking-preview")?.textContent.includes("先检查事件链路")');
  assert.equal(await evaluate('document.querySelector(".process-panel-header").getAttribute("aria-expanded")'),'false');
  await evaluate('window.remoteFixture.event("thinking_delta", {delta:"再确认实时渲染。"})');
  await until('document.querySelector(".process-thinking-preview")?.textContent.includes("再确认实时渲染")');
  assert.equal(await evaluate('document.querySelector(".process-panel-title").textContent'),'正在思考…');
  await capture();
  const animationTime=await evaluate('document.querySelector(".process-spinner").getAnimations()[0]?.currentTime');
  await delay(120);
  await capture();
  const animationProbe=await evaluate('(()=>{const n=document.querySelector(".process-spinner");return {time:n.getAnimations()[0]?.currentTime,name:getComputedStyle(n).animationName,reduced:matchMedia("(prefers-reduced-motion: reduce)").matches}})()');
  assert.ok(animationProbe.time>Number(animationTime),JSON.stringify({before:animationTime,...animationProbe}));
  pass('thinking deltas appear immediately in the folded panel and the activity animation advances');
  await evaluate('document.querySelector(".process-panel-header").click()');
  await evaluate('window.remoteFixture.event("thinking_delta", {delta:"\\n"+"逐段核对真实事件与界面。\\n".repeat(50)})');
  await until('document.querySelector(".process-thinking").scrollHeight > document.querySelector(".process-thinking").clientHeight');
  await delay(100);
  assert.ok(await evaluate('(()=>{const n=document.querySelector(".process-thinking");return n.scrollHeight-n.scrollTop-n.clientHeight<3})()'));
  await evaluate('(()=>{const n=document.querySelector(".process-thinking");n.scrollTop=0;n.dispatchEvent(new Event("scroll"))})()');
  await evaluate('window.remoteFixture.event("thinking_delta", {delta:"保留手动阅读位置。"})');
  await delay(100);
  assert.equal(await evaluate('document.querySelector(".process-thinking").scrollTop'),0);
  pass('expanded thinking follows new text until the reader scrolls up');
  await evaluate('document.querySelector(".process-panel-header").click()');
  await until('!!document.querySelector(".process-thinking-preview") && !document.querySelector(".process-thinking")');
  assert.ok(await evaluate('(()=>{const height=document.querySelector(".process-thinking-preview").getBoundingClientRect().height;return height>=207 && height<=209})()'));
  assert.ok(await evaluate('document.querySelector(".process-thinking-preview").textContent.includes("保留手动阅读位置")'));
  await delay(250);
  fs.mkdirSync(artifactDir,{recursive:true});
  fs.writeFileSync(path.join(artifactDir,'thinking-live.png'),(await capture()).toPNG());
  await evaluate('window.remoteFixture.event("text_delta", {delta:"流式回复。", final:true})');
  await until('!!document.querySelector(".response-streaming-caret")');
  assert.equal(await evaluate('!!document.querySelector(".process-thinking-preview")'),false);
  assert.equal(await evaluate('document.querySelector(".process-panel-title").textContent'),'正在生成回复…');
  await evaluate('window.remoteFixture.event("assistant_end")');
  await until('!document.querySelector(".process-spinner") && !document.querySelector(".streaming-caret")');
  await evaluate('document.querySelector(".process-panel-header").click()');
  assert.ok(await evaluate('document.querySelector(".process-thinking").textContent.includes("保留手动阅读位置")'));
  await evaluate('document.querySelector(".process-panel-header").click()');
  pass('reply and completion transition stop the thinking preview and animations while retaining the full record');
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

  // request_user_input / 用户回答选项：真实手机宽度下验证布局、点击、提交和结果回显。
  await evaluate('window.remoteFixture.interaction("confirm")');
  await until('!!document.querySelector(".remote-interaction-card") && document.querySelectorAll(".remote-interaction-btn").length===2');
  assert.equal(await evaluate('document.querySelector(".remote-interaction-title").textContent'),'确认继续执行吗？');
  await evaluate('document.querySelector(".remote-interaction-btn.primary").click()');
  await until('document.querySelector(".remote-interaction-history-answer")?.textContent.includes("已确认")');
  assert.equal(await evaluate('window.interactionProbe.answers[0]'),true);
  pass('Android confirm interaction submits a boolean answer and immediately renders resolved state');

  await evaluate('window.remoteFixture.interaction("single_select")');
  await until('document.querySelectorAll(".remote-interaction-option").length===3');
  for(const width of [360,412]){
    win.setContentSize(width,800);await delay(80);
    const interactionBounds=await evaluate("(()=>{const timeline=document.querySelector('.chat-timeline');const card=document.querySelector('.remote-interaction-card');const options=[...document.querySelectorAll('.remote-interaction-option')];return {timelineClient:timeline.clientWidth,timelineScroll:timeline.scrollWidth,cardWidth:card.getBoundingClientRect().width,optionHeights:options.map(n=>n.getBoundingClientRect().height)}})()");
    assert.ok(interactionBounds.timelineScroll<=interactionBounds.timelineClient+1,JSON.stringify(interactionBounds));
    assert.ok(interactionBounds.cardWidth<=interactionBounds.timelineClient+1,JSON.stringify(interactionBounds));
    assert.ok(interactionBounds.optionHeights.every(h=>h>=52),JSON.stringify(interactionBounds));
  }
  fs.mkdirSync(artifactDir,{recursive:true});
  fs.writeFileSync(path.join(artifactDir,'interaction-options.png'),(await capture()).toPNG());
  await evaluate('document.querySelectorAll(".remote-interaction-option")[1].click()');
  assert.equal(await evaluate('document.querySelectorAll(".remote-interaction-option")[1].getAttribute("aria-checked")'),'true');
  await evaluate('[...document.querySelectorAll(".remote-interaction-btn")].find(b=>b.textContent.includes("提交回答")).click()');
  await until('document.querySelector(".remote-interaction-history-answer")?.textContent.includes("稳定优先")');
  assert.equal(await evaluate('window.interactionProbe.answers[0]'),'stable');
  pass('Android single-select interaction is touch sized, accessible and submits the selected option id');

  await evaluate('window.remoteFixture.interaction("multi_select")');
  await until('document.querySelectorAll(".remote-interaction-option").length===3');
  await evaluate('document.querySelectorAll(".remote-interaction-option")[0].click();document.querySelectorAll(".remote-interaction-option")[2].click()');
  assert.equal(await evaluate('document.querySelector(".remote-interaction-selection-hint").textContent.includes("已选 2")'),true);
  assert.equal(await evaluate('document.querySelectorAll(".remote-interaction-option")[1].disabled'),true);
  await evaluate('[...document.querySelectorAll(".remote-interaction-btn")].find(b=>b.textContent.includes("提交回答")).click()');
  await until('document.querySelector(".remote-interaction-history-answer")?.textContent.includes("平衡方案")');
  assert.deepEqual(await evaluate('window.interactionProbe.answers[0]'),['balanced','fast']);
  pass('Android multi-select enforces maxSelections and submits the selected ids as one answer');

  for(const kind of ['short_text','long_text']){
    await evaluate('window.remoteFixture.interaction('+JSON.stringify(kind)+')');
    const selector=kind==='long_text'?'.remote-interaction-textarea':'.remote-interaction-input';
    await until('!!document.querySelector('+JSON.stringify(selector)+')');
    const inputScript='(()=>{const n=document.querySelector('+JSON.stringify(selector)+');const p='+(kind==='long_text'?'HTMLTextAreaElement':'HTMLInputElement')+'.prototype;const set=Object.getOwnPropertyDescriptor(p,"value").set;set.call(n,"Android 回答内容");n.dispatchEvent(new Event("input",{bubbles:true}))})()';
    await evaluate(inputScript);
    await until('[...document.querySelectorAll(".remote-interaction-btn")].find(b=>b.textContent.includes("提交回答"))?.disabled===false');
    await evaluate('[...document.querySelectorAll(".remote-interaction-btn")].find(b=>b.textContent.includes("提交回答")).click()');
    await until('document.querySelector(".remote-interaction-history-answer")?.textContent.includes("Android 回答内容")');
    assert.equal(await evaluate('window.interactionProbe.answers[0]'),'Android 回答内容');
  }
  pass('Android short-text and long-text interactions both submit controlled input correctly');
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
  for (const language of ['xml', 'html', '']) {
    await evaluate(`window.remoteFixture.markupFence(${JSON.stringify(language)})`);
    await until('document.querySelector(".md-svg-image")?.naturalWidth > 0');
    assert.equal(await evaluate('!!document.querySelector(".code-block-container")'), false);
    if (language === 'xml') {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, 'xml-svg-preview.png'), (await capture()).toPNG());
    }
  }
  pass('XML, HTML and unlabelled SVG fences decode as images at Android width');
  await evaluate('window.remoteFixture.markupFence("xml", "<?xml version=\\"1.0\\"?>\\n" + window.remoteFixture.svg)');
  await until('document.querySelector(".md-svg-image")?.naturalWidth > 0');
  await evaluate('window.remoteFixture.markupFence("xml", "<settings><svg>example</svg></settings>")');
  await until('!!document.querySelector(".code-block-container") && !document.querySelector(".md-svg-card")');
  await evaluate('window.remoteFixture.markupFence("javascript", window.remoteFixture.svg)');
  await until('!!document.querySelector(".code-block-container") && !document.querySelector(".md-svg-card")');
  await evaluate('window.remoteFixture.markupFence("xml", "<svg xmlns=\\"http://www.w3.org/2000/svg\\"><script>window.bad=true</script></svg>")');
  await until('!!document.querySelector(".md-svg-error")');
  assert.equal(await evaluate('!!window.bad'), false);
  pass('content detection preserves ordinary code and applies SVG safety validation');
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

  await evaluate('window.remoteFixture.navigation("home")');
  await until('!!document.querySelector(".claude-home")');await delay(280);
  await evaluate('window.remoteFixture.navigation("first")');
  await until('document.querySelector(".chat-timeline")?.getAnimations().length===1');
  const direction=await evaluate('document.querySelector(".chat-timeline").getAnimations()[0].effect.getKeyframes()[0].transform');
  assert.ok(direction.includes('22px'),direction);
  const composerBounds=await evaluate('(()=>{const n=document.querySelector(".claude-composer-wrapper");return {bottom:n.getBoundingClientRect().bottom,height:innerHeight}})()');
  assert.ok(Math.abs(composerBounds.bottom-composerBounds.height)<1,JSON.stringify(composerBounds));
  pass('home-to-chat slides forward while the fixed composer stays anchored to the viewport');
  await evaluate('window.remoteFixture.back()');
  await until('document.querySelector(".home-scrollable-content")?.getAnimations().length===1');
  assert.ok((await evaluate('document.querySelector(".home-scrollable-content").getAnimations()[0].effect.getKeyframes()[0].transform')).includes('-18px'));
  pass('Android back navigation returns home with a reverse slide');
  for(const screen of ['first','second','first','second']) { await evaluate('window.remoteFixture.navigation('+JSON.stringify(screen)+')'); await delay(30); }
  assert.equal(await evaluate('document.querySelectorAll(".claude-chat").length'),1);
  assert.equal(await evaluate('document.querySelector(".chat-timeline").textContent.includes("SECOND_TASK_ONLY")'),true);
  await delay(280);
  assert.equal(await evaluate('document.querySelector(".chat-timeline").getAnimations().length'),0);
  const identity=await evaluate('window.navigationTimeline=document.querySelector(".chat-timeline");true');assert.equal(identity,true);
  await evaluate('window.remoteFixture.refreshUnchanged()');await delay(80);
  assert.equal(await evaluate('window.navigationTimeline===document.querySelector(".chat-timeline") && window.navigationTimeline.getAnimations().length===0'),true);
  pass('rapid task switches leave only the latest conversation; background refresh does not replay navigation');
  for(const panel of ['drawer','model','add']) {
    const selector=panel==='drawer'?'.claude-drawer':panel==='model'?'.claude-sheet:last-child':'.claude-sheet';
    await evaluate('window.remoteFixture.panel('+JSON.stringify(panel)+',true)');
    await until('document.querySelector('+JSON.stringify(selector)+').classList.contains("open")');await delay(40);
    assert.ok(await evaluate('document.querySelector('+JSON.stringify(selector)+').getAnimations().length>0'));
    await evaluate('window.remoteFixture.back()');
    assert.equal(await evaluate('document.querySelector('+JSON.stringify(selector)+').inert'),true);
    await until('getComputedStyle(document.querySelector('+JSON.stringify(selector)+')).visibility==="hidden"');
    assert.equal(await evaluate('getComputedStyle(document.querySelector('+JSON.stringify(selector)+')).visibility'),'hidden');
  }
  pass('drawer and both sheets animate in and out; back immediately disables closed controls');
  await evaluate('window.remoteFixture.panel("drawer",true);window.remoteFixture.panel("notifications",true)');
  await until('!!document.querySelector(".notifications-card")');await delay(220);
  const noticeBounds=await evaluate('(()=>{const n=document.querySelector(".notifications-card").getBoundingClientRect();return {height:n.height,top:n.top,bottom:n.bottom,viewport:innerHeight}})()');
  assert.ok(noticeBounds.height>30&&noticeBounds.top>=0&&noticeBounds.bottom<noticeBounds.viewport,JSON.stringify(noticeBounds));
  fs.writeFileSync(path.join(artifactDir,'navigation-notifications.png'),(await capture()).toPNG());
  await evaluate('window.remoteFixture.panel("notifications",false)');
  assert.equal(await evaluate('document.querySelector(".remote-popover").inert'),true);
  await delay(50);await evaluate('window.remoteFixture.panel("notifications",true)');await delay(220);
  assert.equal(await evaluate('document.querySelectorAll(".notifications-card").length'),1);
  assert.equal(await evaluate('document.querySelector(".remote-popover").inert'),false);
  await evaluate('window.remoteFixture.panel("notifications",false)');
  await until('!document.querySelector(".notifications-card")');
  pass('notification expansion and close survive rapid reversal without duplicate or invisible controls');

  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate('window.remoteFixture.navigation("home")');await delay(40);
  assert.equal(await evaluate('document.querySelector(".home-scrollable-content").getAnimations().length'),0);
  await evaluate('window.remoteFixture.panel("model",true)');await delay(40);
  assert.equal(await evaluate('[...document.querySelectorAll(".claude-sheet")].some(n=>n.getAnimations().length>0)'),false);
  await evaluate('window.remoteFixture.back();window.remoteFixture.panel("drawer",true);window.remoteFixture.panel("notifications",true)');
  await until('!!document.querySelector(".notifications-card")');
  await evaluate('window.remoteFixture.panel("notifications",false)');await delay(30);
  assert.equal(await evaluate('!!document.querySelector(".notifications-card")'),false);
  pass('system reduced-motion setting disables page, sheet and disclosure animation');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  win.webContents.debugger.detach();

  fs.mkdirSync(artifactDir,{recursive:true});
  fs.writeFileSync(path.join(artifactDir,'renderer-results.json'),JSON.stringify({ok:true,passed:results.length,results},null,2));
  fs.writeFileSync(path.join(artifactDir,'renderer.png'),(await capture()).toPNG());
  log(JSON.stringify({ok:true,passed:results.length}));win.destroy();app.exit(0);
}).catch(error=>{
  try {
    // Persist failure before touching stderr, which may have lost its reader too.
    fs.mkdirSync(artifactDir,{recursive:true});
    fs.writeFileSync(path.join(artifactDir,'renderer-results.json'),JSON.stringify({ok:false,error:String(error),errorCode:error.code,results},null,2));
    try { fs.writeSync(2,(error.stack || String(error))+'\n'); } catch { /* Caller may have closed stderr. */ }
  } finally {
    // Also exit if recording diagnostics fails; a headless test must never linger in a dialog.
    app.exit(1);
  }
});
