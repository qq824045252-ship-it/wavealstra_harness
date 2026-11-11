const {runRendererFixture}=require('./renderer-fixture-driver.cjs');
const {settleFramesScript}=require('./ui-capture.cjs');
const {writeFileSync}=require('node:fs');
const {join}=require('node:path');
const assert=require('node:assert/strict');
runRendererFixture({name:'diagnostics-cache-ui',width:1200,height:1000}, async f=>{
 const output=join(__dirname,'../out/tests');const html=join(output,'diagnostics-cache-ui.html');
 writeFileSync(html,'<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="diagnostics-cache-ui.css"><div id="root"></div><script src="diagnostics-cache-ui.js"></script>');
 await f.loadFile(html);await f.evaluate(settleFramesScript);
 const states=await f.evaluate(`({rates:[...document.querySelectorAll('[data-testid="turn-cache"]')].map(e=>({text:e.textContent,alert:e.classList.contains('td-cache--alert')})),dots:[...document.querySelectorAll('.td-trend-dot')].map(e=>({alert:e.dataset.cacheAlert,title:e.textContent}))})`);
 assert.equal(states.rates.length,3);assert(states.rates[0].text.includes('0%'));assert.equal(states.rates[0].alert,false);
 assert(states.rates[1].text.includes('90%'));assert.equal(states.rates[1].alert,false);assert.equal(states.rates[2].alert,true);
 assert.deepEqual(states.dots.map(x=>x.alert),['false','false','true']);
 await f.screenshot(join(output,'diagnostics-cold-baseline.png'));
 await f.evaluate(`[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('子代理')).click()`);await f.evaluate(settleFramesScript);
 assert.equal(await f.evaluate(`document.querySelectorAll('.td-cache--alert').length`),0);
 assert.equal(await f.evaluate(`document.querySelector('.td-trend-dot').dataset.cacheAlert`),'false');
 console.log('PASS cold baseline neutral, prewarm kept, later cache loss highlighted, child baseline independent');
});
