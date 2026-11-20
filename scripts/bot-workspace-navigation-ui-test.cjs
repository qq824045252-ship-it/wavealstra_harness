const {runRendererFixture}=require('./renderer-fixture-driver.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.join(__dirname,'../out/tests');
runRendererFixture({name:'bot-workspace-navigation',width:1200,height:900,show:process.argv.includes('--visible')},async fixture=>{
 const run=code=>fixture.evaluate(code);
 const openCompleted=async title=>{
   const result=await run("(()=>{const rows=[...document.querySelectorAll('button.workspace-foreground-row')].filter(row=>row.getAttribute('title')==="+JSON.stringify(title)+");if(rows.length!==1)return 'expected one matching row, found '+rows.length;const [row]=rows;if(row.querySelector('.task-status-indicator'))return 'completed indicator still visible';row.click();return 'opened'})()");
   assert.equal(result,'opened','Completed row remains navigable with no status indicator: '+title);
 };
 const wait=async code=>{const end=Date.now()+8000;while(!await run(code)){if(Date.now()>end)throw Error('timeout '+code);await new Promise(r=>setTimeout(r,30));}};
 fs.writeFileSync(path.join(out,'bot-workspace-navigation-ui.html'),'<html><head><link rel="stylesheet" href="bot-workspace-navigation-ui.css"></head><body><div id="root"></div><script src="bot-workspace-navigation-ui.js"></script></body></html>');
 await fixture.loadFile(path.join(out,'bot-workspace-navigation-ui.html'));
 const checkNavigation=async()=>{
 await wait(`document.querySelectorAll('.workspace-conversation-row').length===3`);
 assert.equal(await run(`document.querySelectorAll('.workspace-foreground-row').length`),0,'conversation task lists initially collapsed');
 await run(`[...document.querySelectorAll('.workspace-conversation-row')].forEach(button=>button.click())`);
 await wait(`document.querySelectorAll('.workspace-foreground-row').length===23`);
 await openCompleted('个人任务0');
 await wait(`document.querySelector('.workspace-foreground-messages')?.innerText.includes('个人任务0结果')`);
 assert.equal(await run(`document.querySelectorAll('.workspace-foreground-messages .bot-message-work-links button').length`),1,'workspace request detail deduplicates shared Work link');
 assert.equal(await run(`Boolean(document.querySelector('.bot-composer, #bot-draft'))`),false,'historical view has no retired composer');
 if(fixture.backend!=='dom') {
   const bounds=await run(`(()=>{const e=document.querySelector('.workspace-foreground-messages'),r=e.getBoundingClientRect();return {width:r.width,height:r.height,overflow:e.scrollWidth>e.clientWidth+1}})()`);
   assert(bounds.width>400&&bounds.height>100&&!bounds.overflow,'historical transcript remains visible without horizontal overflow');
   assert(await fixture.screenshot(path.join(out,'historical-conversation.png')),'historical transcript screenshot saved');
 }

 assert.equal(await run(`document.querySelectorAll('.workspace-foreground-messages .bot-message.assistant .bot-message-work-links').length`),0,'workspace reply does not repeat the input card');
 assert.equal(await run(`document.querySelectorAll('.workspace-foreground-messages .bot-reply-reference').length`),0,'link context does not add a duplicate question quote in request detail');
 await run(`document.querySelector('.workspace-foreground-heading button').click()`);
 await wait(`!!document.querySelector('.workspace-overview')`);
 assert.equal(await run(`document.querySelectorAll('.workspace-overview .workspace-overview-task-row').length`),31);
 await run(`[...document.querySelectorAll('.workspace-foreground-row')].find(b=>b.textContent.includes('再看')).click()`);
 await wait(`document.querySelectorAll('.workspace-foreground-row').length===36`);
 await openCompleted('个人任务0');
 await wait(`!!document.querySelector('.workspace-foreground-messages h2')`);
 assert((await run(`document.querySelector('.workspace-foreground-messages').innerText`)).includes('个人任务0结果'));
 assert(!(await run(`document.querySelector('.workspace-foreground-messages').innerText`)).includes('个人任务1结果'));
 await openCompleted('个人任务34');
 await wait(`document.querySelector('.workspace-foreground-messages')?.innerText.includes('个人任务34结果')`);
 assert(!(await run(`document.querySelector('.workspace-foreground-messages').innerText`)).includes('个人任务0结果'));
 await run(`document.querySelector('.workspace-foreground-heading button').click()`);
 await wait(`!!document.querySelector('.workspace-overview')`);
 await openCompleted('团队任务');
 await wait(`document.querySelector('.workspace-foreground-messages')?.innerText.includes('团队任务结果')`);
 await run(`[...document.querySelectorAll('.space-header')].find(b=>b.querySelector('.space-name').textContent==='学习搭子').click()`);
 await wait(`!!document.querySelector('.workspace-overview')`);
 assert(!await run(`!!document.querySelector('.workspace-foreground-messages')`),'folder navigation never reopens stale selected request');
 };
 try { await checkNavigation(); }
 finally { await run('window.cleanupWorkspaceFixture?.()'); }
 console.log('PASS navigation UI: per-conversation groups under one Bot, exact cross-conversation switching, paginated list, exact archived request, markdown, team isolation, back/folder return');
});
