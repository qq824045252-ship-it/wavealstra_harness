const {runRendererFixture}=require('./renderer-fixture-driver.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const width=Number(process.env.UI_TEST_WIDTH||1440),out=path.resolve('out/tests');
runRendererFixture({name:'bot-interface',width,height:960,show:true},async f=>{
 const run=s=>f.evaluate(s),wait=async s=>{for(let i=0;i<160;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,40));}throw Error('timeout: '+s);};
 const html=path.join(out,'bot-interface-desktop.html');
 fs.writeFileSync(html,'<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="bot-interface-desktop-fixture.css"></head><body><div id="root"></div><script src="bot-interface-desktop-fixture.js"></script></body></html>');
 await f.loadFile(html);await wait('Boolean(window.concurrentFixture) && document.querySelectorAll(".bot-display-row").length===3');
 // Enter during Chinese composition must not submit. Shift+Enter remains a newline.
 await run(`window.concurrentFixture.draft('中文输入')`);await wait(`document.querySelector('textarea').value==='中文输入'`);
 await run(`document.querySelector('textarea').dispatchEvent(Object.assign(new Event('keydown',{bubbles:true,cancelable:true}),{key:'Enter',isComposing:true}))`);
 await run(`document.querySelector('textarea').dispatchEvent(Object.assign(new Event('keydown',{bubbles:true,cancelable:true}),{key:'Enter',shiftKey:true}))`);
 assert.equal(await run('window.concurrentFixture.requests.length'),0);
 for(const text of ['请帮我整理今天的工作重点','再核对团队的协作进度','也检查一下附件与交付要求']){
  await run(`window.concurrentFixture.draft(${JSON.stringify(text)})`);await wait(`!document.querySelector('[aria-label="发送消息"]').disabled`);
  await run(`document.querySelector('[aria-label="发送消息"]').click()`);
 }
 await wait('window.concurrentFixture.requests.length===3');
 await run('window.concurrentFixture.acknowledge(0);window.concurrentFixture.acknowledge(1);window.concurrentFixture.acknowledge(2)');
 const answer=['可以先从这三件事开始。','','### 今天的重点','','1. **确认目标**：先整理需求和已有结果。','2. **安排协作**：明确每位 Bot 的职责。','3. **核对交付**：保留来源、附件与待确认项。','','| 事项 | 下一步 |','| --- | --- |','| 产品方案 | 核对范围 |','| 团队进展 | 汇总结果 |'].join('\n');
 await run(`window.concurrentFixture.answer(0,${JSON.stringify(answer)},11,'completed');window.concurrentFixture.setMetrics(0,100000)`);
 await wait(`document.querySelector('.bot-reply-metrics')?.textContent.includes('输入 0.100M')`);
 assert.equal(await run(`document.querySelector('.bot-reply-metrics').open`),false);
 await run(`document.querySelector('.bot-reply-metrics summary').focus()`);
 await run(`document.querySelector('.bot-reply-metrics summary').click()`);
 await wait(`document.querySelector('.bot-reply-metrics').open`);
 assert(await run(f.backend==='dom' ? `window.__fixtureVisible(document.querySelector('[data-metric="cacheRead"]'))` : `document.querySelector('[data-metric="cacheRead"]').getBoundingClientRect().height>0`));
 await run(`document.querySelector('.bot-reply-metrics summary').click()`);
 // Composer stop targets B, keeps C running and leaves a typed followup untouched.
 await run(`window.concurrentFixture.draft('补充：请保留现有附件')`);
 const requestB=await run('window.concurrentFixture.requests[1].requestId');
 await wait(`document.querySelector('.bot-composer-stop')?.dataset.requestId===${JSON.stringify(requestB)}`);
 assert(await run(`document.querySelector('.bot-composer-stop').title.includes('再核对团队的协作进度')`));
 await run(`document.querySelector('.bot-composer-stop').click()`);
 await wait('window.concurrentFixture.cancellations.length===1');
 assert.equal(await run('window.concurrentFixture.cancellations[0]'),requestB);
 assert.equal(await run(`document.querySelector('textarea').value`),'补充：请保留现有附件');
 if(f.backend!=='dom') assert(await run(`document.activeElement===document.querySelector('textarea')`));
 assert(await run(`!document.querySelector('[aria-label="发送消息"]').disabled`));
 assert.equal(await run(`document.querySelectorAll('.bot-message-stop').length`),1);
 // Per-message stop remains independent of the composer selection.
 await run(`document.querySelector('.bot-message-stop').click()`);
 await wait('window.concurrentFixture.cancellations.length===2');
 assert(await run('window.concurrentFixture.cancellations[1]===window.concurrentFixture.requests[2].requestId'));
 // Work progress messages must not become a composer cancellation target.
 await run(`window.concurrentFixture.updateReply(0,{status:'running',workFeedback:{kind:'binding',workId:'background',category:'progress'}})`);
 await wait(`!document.querySelector('.bot-composer-stop')`);
 await run(`window.concurrentFixture.updateReply(0,{status:'unknown',workFeedback:undefined,error:'来源待核对，请确认后继续。'})`);
 await wait(`document.querySelector('.bot-message.assistant .bot-reply-placeholder')?.textContent.includes('结果待核对') && document.querySelector('[role="alert"]')`);
 assert.equal(await run(`document.querySelector('.bot-reply-metrics').open`),false);
 await run(`window.concurrentFixture.updateReply(0,{status:'completed',error:undefined});window.concurrentFixture.draft('')`);
 if(f.backend==='dom'){await run('window.disposeDirectoryFixture();window.disposeConversationFixture()');console.log('PASS DOM behaviour: concurrent scoped stop, preserved draft, metrics disclosure, foreground/Work separation, visible unknown/error; SKIP pixels, layout, browser focus, themes and zoom');return;}
 await run(`window.concurrentFixture.updateReply(0,{status:'running'})`);
 await wait(`document.querySelector('.bot-composer-stop')`);
 // Verify actual browser geometry, themes, focus and readable content at this width.
 for(const theme of ['light','dark']){
  await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
  await new Promise(r=>setTimeout(r,200));
  assert(await run('document.documentElement.scrollWidth<=innerWidth+1'),'no page overflow');
  const stopContrast=await run(`(()=>{const b=document.querySelector('.bot-composer-stop'),bg=b.closest('.input-box');const luminance=s=>{const c=s.match(/[0-9.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722;};const a=luminance(getComputedStyle(b).color),z=luminance(getComputedStyle(bg).backgroundColor);return(Math.max(a,z)+.05)/(Math.min(a,z)+.05)})()`);
  assert(stopContrast>=3,'active stop icon meets 3:1 non-text contrast');

  assert(await run(`[...document.querySelectorAll('.bot-message-actions button,.bot-composer-send-actions button')].every(e=>{const r=e.getBoundingClientRect();return r.width>=31&&r.height>=31&&r.right<=innerWidth&&e.getAttribute('aria-label')&&e.title})`),'visible named icon controls');
  assert(await run(`document.querySelector('.bot-composer-send-actions').getBoundingClientRect().right<=document.querySelector('.input-box').getBoundingClientRect().right`));
  assert(await run(`getComputedStyle(document.querySelector('.user-bubble')).fontSize===getComputedStyle(document.querySelector('.bot-assistant-content .md')).fontSize`),'consistent body type');
  await f.screenshot(path.join(out,`bot-interface-${width}-${theme}.png`));
 }

 for(const size of [12,20]){
  await run(`window.setPreviewFontSize(${size})`);
  assert(await run(`[...document.querySelectorAll('.user-bubble,.bot-assistant-content .md,.input-textarea')].every(e=>getComputedStyle(e).fontSize==='${size}px')`),'body and composer follow the existing user font preference');
  assert(await run('document.documentElement.scrollWidth<=innerWidth+1'),'supported font size has no page overflow');
  await f.screenshot(path.join(out,`bot-interface-${width}-font-${size}.png`));
 }
 await run('window.setPreviewFontSize(15)');
 if(width===1440){
  assert(await run(`document.querySelector('.interface-directory').getBoundingClientRect().width>0`));
  assert(await run(`[...document.querySelectorAll('.sidebar-bot-identity strong')].every(e=>e.scrollWidth>=e.clientWidth)`));
  await run(`document.documentElement.style.zoom='2'`);await new Promise(r=>setTimeout(r,200));
  assert(await run('document.documentElement.scrollWidth<=innerWidth+1'),'200% layout zoom has no page overflow');
  await f.screenshot(path.join(out,'bot-interface-200pct-layout-zoom.png'));
 }
 console.log(`PASS renderer UI ${width}px: Chinese composition, shortcuts, 3 concurrent sends, independent composer/message stop, draft/focus, Work exclusion, metrics disclosure, visible unknown/error, light/dark layout and named icon targets`);
}).then(() => { if (process.argv.includes('--dom')) process.exit(process.exitCode || 0); });
