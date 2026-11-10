const {runRendererFixture}=require('./renderer-fixture-driver.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.join(__dirname,'../out/tests');
runRendererFixture({name:'model-menu',show:true,width:Number(process.env.UI_TEST_WIDTH||900),height:760},async f=>{
 const run=c=>f.evaluate(c),wait=async c=>{for(let i=0;i<100;i++){if(await run(c))return;await new Promise(r=>setTimeout(r,50));}throw Error('timeout '+c);};
 fs.writeFileSync(path.join(out,'model-menu-ui.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="model-menu-ui.css"></head><body style="margin:0"><div id="root"></div><script src="model-menu-ui.js"></script></body></html>');
 await f.loadFile(path.join(out,'model-menu-ui.html'));await wait(`!!document.querySelector('#open')`);await run(`document.querySelector('#open').click()`);await wait(`!!document.querySelector('[aria-label="Max 模式"]')`);
 await run(`document.querySelector('[aria-label="Max 模式"]').click()`);assert.deepEqual(await run(`window.menuState.prefs['test/a'].reasoning`),{effort:'high'});
 await run(`document.querySelector('.model-option-wrap').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);await wait(`!!document.querySelector('.model-thinking-entry')`);await run(`document.querySelector('.model-thinking-entry').click()`);await wait(`document.querySelectorAll('.model-thinking-level').length>2`); await wait(`document.querySelector('.model-thinking-detail') && getComputedStyle(document.querySelector('.model-thinking-detail')).visibility==='visible'`); await f.screenshot(path.join(out,'model-menu-thinking.png'));
 await run(`[...document.querySelectorAll('.model-thinking-level')].find(b=>b.textContent.trim()==='low').click()`);assert.equal(await run(`window.menuState.prefs['test/a'].reasoning.effort`),'low');await wait(`!document.querySelector('.model-popup')`);
 await run(`document.querySelector('#open').click()`);await wait(`!!document.querySelector('.model-popup')`);await f.screenshot(path.join(out,'model-menu-light.png'));
 await run(`[...document.querySelectorAll('.model-option')].find(b=>b.textContent.includes('Plain model')).click()`);await wait(`!document.querySelector('.model-popup')`);await run(`document.querySelector('#open').click()`);await wait(`!!document.querySelector('.model-popup')`);assert.equal(await run(`document.querySelector('[aria-label="Max 模式"]').disabled`),true);
 await run(`document.documentElement.dataset.theme='dark'`);await f.screenshot(path.join(out,'model-menu-dark.png'));console.log('PASS shared menu Max, thinking, isolated preference, unsupported model, themes');
});
