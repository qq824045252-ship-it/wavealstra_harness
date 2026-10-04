const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Read-only acceptance on the already-open SSH conversation. Never sends a prompt.
const root = path.resolve(__dirname, '..');
const adb = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const serial = process.env.ADB_SERIAL || 'A4UF6R6206002786';
const wait = ms => new Promise(r => setTimeout(r, ms));
const folder = path.join(root, 'out/remote-scroll');
let port, ws, seq = 0; const pending = new Map(); const historyResponses = [];
fs.mkdirSync(folder,{recursive:true});
function run(args) {
  const r = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 9000, windowsHide: true });
  if (r.status !== 0) throw Error(String(r.error || r.stderr || r.stdout));
  return r.stdout.trim();
}
async function command(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout '+method)); }, 10000);
    pending.set(id, {resolve,reject,timer}); ws.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression) {
  const r = await command('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
  if (r.exceptionDetails) throw Error(r.result?.description || r.exceptionDetails.text);
  return r.result?.value;
}
const expression = `(() => {
 const el = document.querySelector('.chat-timeline');
 if (!el) throw Error('No chat scrollport');
 if (!document.querySelector('.header-title-chat')?.textContent.startsWith('ssh ')) throw Error('Not the SSH task; refusing to navigate away');
 const log = []; const start = performance.now(); const ids = new WeakMap(); let next = 0; let last = '';
 const id = n => { if (!ids.has(n)) ids.set(n, ++next); return ids.get(n); };
 function sample(reason = 'tick', extra = {}) {
   const rect = el.getBoundingClientRect();
   const rows = [...el.querySelectorAll(':scope > [data-message-id]')];
   const anchor = rows.find(n => n.getBoundingClientRect().bottom > rect.top + 30);
   const data = {t: Math.round(performance.now()-start),reason,y:el.scrollTop,sh:el.scrollHeight,h:el.clientHeight,users:el.querySelectorAll('.message-bubble-user').length,
     imgs:[...el.querySelectorAll('.md-svg-image')].map(n=>({id:id(n),h:Math.round(n.getBoundingClientRect().height),loaded:n.complete && n.naturalWidth>0})),
     anchor:anchor?.getAttribute('data-message-id'),anchorTop:anchor?Math.round(anchor.getBoundingClientRect().top-rect.top):null,
     spacer:el.querySelector('.chat-bottom-spacer')?.style.height,...extra};
   const signature = JSON.stringify({...data,t:0,reason:''});
   if (signature !== last || reason !== 'tick') { log.push(data); if (log.length>600) log.shift(); last=signature; }
   return data;
 }
 const d = Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
 if (!d?.get || !d?.set) throw Error('scrollTop accessor unavailable');
 Object.defineProperty(Element.prototype,'scrollTop',{...d,set(value){ if(this===el) sample('JS-scrollTop',{target:value,stack:new Error().stack?.split('\\n').slice(1,5).join('\\n')}); return d.set.call(this,value); }});
 const nativeScrollTo=Element.prototype.scrollTo;
 Element.prototype.scrollTo=function(...args){ if(this===el) sample('JS-scrollTo',{args,stack:new Error().stack?.split('\\n').slice(1,5).join('\\n')}); return nativeScrollTo.apply(this,args); };
 const onScroll=()=>sample('scroll'); el.addEventListener('scroll',onScroll,{passive:true});
 const timer=setInterval(()=>sample(),50);
 const mo = new MutationObserver(records=>{ let removed=0,added=0; for(const r of records) { for(const n of r.removedNodes) if(n instanceof Element) removed+=Number(n.matches('.md-svg-card,.md-svg-image'))+n.querySelectorAll('.md-svg-card,.md-svg-image').length; for(const n of r.addedNodes) if(n instanceof Element) added+=Number(n.matches('.md-svg-card,.md-svg-image'))+n.querySelectorAll('.md-svg-card,.md-svg-image').length; } if(removed||added) sample('svg-remount',{removed,added}); });
 mo.observe(el,{childList:true,subtree:true});
 window.__remoteScrollProbe={sample,log,cleanup(){clearInterval(timer);mo.disconnect();el.removeEventListener('scroll',onScroll);Object.defineProperty(Element.prototype,'scrollTop',d);Element.prototype.scrollTo=nativeScrollTo;}};
 return sample('start');
})()`;
(async()=>{
 const version=run(['shell','dumpsys','package','com.mybuddy.remote']);
 const expected=JSON.parse(fs.readFileSync(path.join(root,'app/remote/android/app/build/outputs/apk/debug/output-metadata.json'),'utf8')).elements[0];
 if(!new RegExp('versionCode='+expected.versionCode+'\\b').test(version))throw Error('Expected installed build '+expected.versionName+' / code '+expected.versionCode);
 const pid=run(['shell','pidof','com.mybuddy.remote']).split(/\s+/)[0];
 const socket=run(['shell','cat','/proc/net/unix']).split(/\r?\n/).find(l=>l.includes('@webview_devtools_remote_'+pid))?.split('@').at(-1);
 if(!socket) throw Error('WebView not available');
 port=Number(run(['forward','tcp:0','localabstract:'+socket]));
 const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
 const target=targets.find(t=>t.type==='page'&&t.url.startsWith('https://localhost'));
 if(!target) throw Error('App page not available');
 ws=new WebSocket(target.webSocketDebuggerUrl);
 ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.method==='Network.responseReceived'){ const r=m.params.response;try{const u=new URL(r.url);if(u.pathname.endsWith('/history')&&r.status===200)historyResponses.push({at:Date.now(),path:u.pathname});}catch{}}if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}};
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 await command('Network.enable');
 const result={mode:'phone-scroll-'+expected.versionName,installed:{versionName:expected.versionName,versionCode:expected.versionCode},initial:await evaluate(expression),actions:[],ok:false};
 await wait(8200);
 const wm=run(['shell','wm','size']); const dimensions=[...wm.matchAll(/(\d+)x(\d+)/g)].at(-1);
 if(!dimensions) throw Error('Physical viewport size unknown');
 const w=Number(dimensions[1]),h=Number(dimensions[2]);
 for(const [name,from,to] of [['earlier',0.40,0.73],['later',0.73,0.40]]) {
   await evaluate(`window.__remoteScrollProbe.sample(${JSON.stringify(name+'-gesture')})`);
   run(['shell','input','swipe',String(Math.round(w*0.54)),String(Math.round(h*from)),String(Math.round(w*0.54)),String(Math.round(h*to)),'420']);
   await wait(600);result.actions.push({name,landed:await evaluate(`window.__remoteScrollProbe.sample('gesture-landed')`)});
   await wait(9000);result.actions.at(-1).after=await evaluate(`window.__remoteScrollProbe.sample('hold-complete')`);
 }
 // Exercise the visible return-to-bottom control, then leave the phone untouched
 // across at least three foreground history refreshes (7 seconds each).
 await evaluate("document.querySelector('.chat-timeline').dispatchEvent(new Event('scroll'))");
 await wait(100);
 await evaluate("document.querySelector('.scroll-bottom-btn')?.click()");
 await wait(800);
 result.bottom={start:await evaluate("window.__remoteScrollProbe.sample('bottom-hold-start')"),historyStart:historyResponses.length};
 await wait(23000);
 result.bottom.end=await evaluate("window.__remoteScrollProbe.sample('bottom-hold-end')");
 result.bottom.freshHistoryReads=historyResponses.length-result.bottom.historyStart;
 result.historyResponses=historyResponses;

 result.log=await evaluate('window.__remoteScrollProbe.log');
 result.jsWrites=result.log.filter(x=>x.reason.startsWith('JS-'));
 result.remounts=result.log.filter(x=>x.reason==='svg-remount');
 result.final=await evaluate("window.__remoteScrollProbe.sample('final')");
 const failures=[];
 const check=(ok,message)=>{if(!ok)failures.push(message)};
 const phase=(name,start,end)=>{
   const samples=result.log.filter(x=>x.t>=start.t&&x.t<=end.t);
   const maxDrift=Math.max(0,...samples.map(x=>Math.abs(x.y-start.y)));
   check(maxDrift<=2,name+': unexpected scroll drift '+maxDrift);
   check(start.users===end.users,name+': user turn changed during test');
   const writes=samples.filter(x=>x.reason.startsWith('JS-'));
   check(!writes.length,name+': app wrote scroll position during passive hold');
   return {name,startY:start.y,endY:end.y,maxDrift,scriptWrites:writes.length};
 };
 const phases=result.actions.map(a=>phase(a.name,a.landed,a.after));
 phases.push(phase('bottom across automatic refreshes',result.bottom.start,result.bottom.end));
 check(Math.abs(result.bottom.start.sh-result.bottom.start.h-result.bottom.start.y)<=2,'Return-to-bottom did not reach the actual bottom');
 check(result.bottom.freshHistoryReads>=3,'Fewer than three real server history reads observed during bottom hold');
 check(result.initial.imgs.length>=7,'Real SSH history SVGs were not all mounted');
 const originalIds=result.initial.imgs.map(x=>x.id);
 check(originalIds.every(id=>result.final.imgs.some(x=>x.id===id&&x.loaded)),'Historical SVG nodes were replaced or lost');
 check(!result.remounts.some(x=>x.removed>0),'Historical SVG previews were unmounted during a passive update');
 result.failures=failures;result.ok=failures.length===0;
 result.summary={installed:result.installed,ok:result.ok,phases,decodedHistoricalSvgs:originalIds.length,svgRemounts:result.remounts.filter(x=>x.removed>0).length,freshHistoryReadsDuringBottomHold:result.bottom.freshHistoryReads,holdMs:result.bottom.end.t-result.bottom.start.t,failures};
 fs.writeFileSync(path.join(folder,result.mode+'.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result.summary,null,2));
 if(failures.length)process.exitCode=1;

})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{try{if(ws?.readyState===1)await evaluate('window.__remoteScrollProbe?.cleanup();delete window.__remoteScrollProbe')}catch{};ws?.close();if(port)try{run(['forward','--remove','tcp:'+port])}catch{};});
