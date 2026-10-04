const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const serial='A4UF6R6206002786';const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
const folder=path.join(root,'artifacts/remote-android-20260930');fs.mkdirSync(folder,{recursive:true});
const result={ok:false,stage:'starting',checks:[],network:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));let cdp,port;
function save(){fs.writeFileSync(path.join(folder,'phone-results.json'),JSON.stringify(result,null,2))}
function run(args){const r=spawnSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:8000,windowsHide:true});if(r.status!==0)throw Error('adb '+args.slice(0,3).join(' ')+': '+(r.stderr||r.error||r.stdout));return r.stdout.trim()}
function pass(name,details){result.checks.push({name,ok:true,...(details?{details}:{})});result.stage=name;save();console.log('PASS '+name)}
class CDP {
  constructor(url){this.ws=new WebSocket(url);this.seq=0;this.pending=new Map();this.requests=new Map();this.ready=new Promise((resolve,reject)=>{this.ws.onopen=resolve;this.ws.onerror=reject});this.ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);return}if(m.method==='Network.responseReceived'){const v=m.params.response;try{const u=new URL(v.url);if(u.protocol==='https:'&&u.hostname.endsWith('.ts.net')&&v.status!==204){const row={path:u.pathname,status:v.status,at:Date.now()};result.network.push(row);this.requests.set(m.params.requestId,u.pathname);if(result.network.length>100)result.network.shift()}}catch{}}if(m.method==='Network.dataReceived'&&this.requests.get(m.params.requestId)==='/v1/events')result.sseChunks=(result.sseChunks||0)+1}}
  async send(method,params={}){await this.ready;const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout '+method))},15000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}))})}
  async evaluate(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+' '+(r.result?.description||''));return r.result?.value}
  close(){this.ws.close();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('closed'))}this.pending.clear()}
}
async function attach(){
  const pid=run(['shell','pidof','com.mybuddy.remote']).split(/\s+/)[0];
  const sockets=run(['shell','cat','/proc/net/unix']);const socket=sockets.split(/\r?\n/).find(l=>l.includes('webview_devtools_remote_'+pid))?.split('@').at(-1);
  if(!socket)throw Error('Android WebView debugger socket not ready');
  port=Number(run(['forward','tcp:0','localabstract:'+socket]));
  const targets=await (await fetch('http://127.0.0.1:'+port+'/json')).json();
  const target=targets.find(t=>t.type==='page'&&t.url.startsWith('https://localhost'));
  if(!target)throw Error('MyBuddy Remote page unavailable');
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.ready;await cdp.send('Network.enable');
}
async function until(expression,timeout=20000){const begin=Date.now();while(Date.now()-begin<timeout){const v=await cdp.evaluate(expression);if(v)return v;await delay(300)}throw Error('Phone condition timeout: '+expression.slice(0,160))}
async function state(){return cdp.evaluate(`(()=>{const t=document.querySelector('.chat-timeline');const nodes=[...document.querySelectorAll('.chat-timeline > [data-message-id]')];return {title:document.querySelector('.header-title-chat')?.textContent,connected:!!document.querySelector('.claude-header'),users:nodes.filter(n=>n.classList.contains('message-bubble-user')).length,assistants:nodes.filter(n=>n.classList.contains('message-bubble-assistant')).length,svg:[...document.querySelectorAll('.md-svg-image')].map(i=>({complete:i.complete,width:i.naturalWidth,height:i.naturalHeight})),openPanels:document.querySelectorAll('.process-panel.open').length,openTools:document.querySelectorAll('.claude-tool-card.open').length,overlap:nodes.some((n,i)=>i&&n.offsetTop<nodes[i-1].offsetTop+nodes[i-1].offsetHeight-1),viewport:t?{width:t.clientWidth,scrollWidth:t.scrollWidth,height:t.clientHeight,scrollTop:t.scrollTop}:null,hasDraft:!!document.querySelector('textarea')?.value}})()`)}
async function screenshot(name){const data=await cdp.send('Page.captureScreenshot',{format:'png'});fs.mkdirSync('out/remote-tests/phone',{recursive:true});fs.writeFileSync(path.join('out/remote-tests/phone',name+'.png'),Buffer.from(data.data,'base64'))}
async function cleanup(){try{if(cdp)await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1})}catch{};cdp?.close();if(port)try{run(['forward','--remove','tcp:'+port])}catch{};port=undefined}
(async()=>{
  const version=run(['shell','dumpsys','package','com.mybuddy.remote']);if(!/versionCode=6\b/.test(version))throw Error('Expected Android code 6');pass('installed 1.1.4 / code 6');
  await attach();await until('!!document.querySelector(".claude-header")');
  const original=await state();result.initial={...original,title:undefined};pass('real Android authenticated page loaded',result.initial);
  if(process.argv.includes('--inspect')){await delay(7500);result.final=await state();result.final.title=undefined;result.ok=true;return}
  if(original.hasDraft)throw Error('Unsent draft present; refusing to overwrite it during acceptance');
  // Inspect an EXISTING server task with real historical SVG, via normal navigation.
  await cdp.evaluate('document.querySelector("button[aria-label=菜单]")?.click()');await delay(400);
  const found=await cdp.evaluate(`(()=>{const b=[...document.querySelectorAll('.drawer-item-btn')].find(b=>b.textContent.trim().startsWith('ssh '));if(b)b.click();return !!b})()`);
  if(found){
    await until('document.querySelector(".header-title-chat")?.textContent.startsWith("ssh ")');
    await until('document.querySelector(".md-svg-image")?.naturalWidth > 0');
    const snap=await state();if(snap.overlap)throw Error('Historical chat rows overlap');
    if(snap.openPanels||snap.openTools)throw Error('Existing tools auto-expanded');
    pass('real historical SSH task SVG decoded and all tools remain folded',{svgCount:snap.svg.length,overlap:snap.overlap});
    await screenshot('phone-existing-svg');
  }
  // A single harmless REAL model task, submitted through the shipped UI.
  await cdp.evaluate('document.querySelector("button[aria-label=新对话]")?.click()');
  await until('!!document.querySelector("textarea") && !document.querySelector(".header-title-chat")');
  const prompt="原样回复以下内容，不需要规划，不调用任何工具：\nREMOTE_ANDROID_20260930_OK\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 100\"><rect width=\"320\" height=\"100\" fill=\"#ddeeff\"/><text x=\"20\" y=\"60\" font-size=\"24\">Android PASS</text></svg>\n```\n验收完成";
  await cdp.evaluate(`(()=>{const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(prompt)});t.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(250);
  await until('!!document.querySelector("button[aria-label=发送]") && !document.querySelector("button[aria-label=发送]").disabled');
  await cdp.evaluate('document.querySelector("button[aria-label=发送]").click()');
  result.stage='waiting-real-model';save();
  const samples=[];let completed=false;
  await cdp.evaluate('window.dispatchEvent(new Event("online"))');
  for(let i=0;i<150;i++){
    const v=await cdp.evaluate(`(()=>{const a=[...document.querySelectorAll('.message-bubble-assistant')];const last=a.at(-1);return {length:last?.innerText.length??0,marker:last?.textContent.includes('REMOTE_ANDROID_20260930_OK')??false,svg:!!last?.querySelector('.md-svg-image')?.naturalWidth,end:last?.textContent.includes('验收完成')??false,stop:!!document.querySelector('button[aria-label=停止]'),open:document.querySelectorAll('.process-panel.open').length,toolsOpen:document.querySelectorAll('.claude-tool-card.open').length}})()`);
    if(v.length!==samples.at(-1)?.length)samples.push(v);
    if(v.open||v.toolsOpen)throw Error('Real generation auto-expanded process/tool details');
    if(v.marker&&v.svg&&v.end&&!v.stop){completed=true;break}
    await delay(500);
  }
  result.samples=samples;
  if(!completed)throw Error('Real model task did not reach verified final state');
  const snap=await state();if(snap.overlap)throw Error('Real reply overlaps its user row');
  const order=await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('.chat-timeline > [data-message-id]')];const u=rows.findIndex(n=>n.classList.contains('message-bubble-user'));const a=rows.findIndex(n=>n.classList.contains('message-bubble-assistant')&&n.textContent.includes('REMOTE_ANDROID_20260930_OK'));return {u,a}})()`);
  if(!(order.a>order.u))throw Error('Real reply precedes its user');
  pass('real phone submission streamed to completion with SVG below its user',{samples:samples.length,sseChunks:result.sseChunks||0,order});
  await screenshot('phone-real-reply');
  // Fault injection is restricted to this WebView. Never alter VPN, system routes or tokens.
  await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await delay(1800);
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  const beforeNetwork=result.network.length;
  await cdp.evaluate('window.dispatchEvent(new Event("online"))');await delay(9500);
  const recovered=result.network.slice(beforeNetwork).some(x=>x.path.endsWith('/history')&&x.status===200);
  if(!recovered)throw Error('No fresh successful history read after reconnection');
  pass('actual Android WebView reconnect recovered fresh history without re-pairing');
  run(['shell','input','keyevent','3']);await delay(800);run(['shell','am','start','-W','-n','com.mybuddy.remote/.MainActivity']);await delay(1800);
  await until('!!document.querySelector(".md-svg-image")?.naturalWidth');pass('background to foreground preserves rendered reply and resumes sync');
  // Return to the user's previous task, without sending anything to it.
  if(original.title){await cdp.evaluate('document.querySelector("button[aria-label=菜单]")?.click()');await delay(250);await cdp.evaluate(`(()=>{const buttons=[...document.querySelectorAll('.drawer-item-btn')];const b=buttons.find(b=>b.textContent.trim().startsWith('要注册商标'))??buttons.find(b=>b.textContent.trim()===${JSON.stringify(original.title)});b?.click()})()`)}
  result.ok=true;result.stage='complete';
})().catch(error=>{result.error=String(error);result.stage='failed';console.error(error)}).finally(async()=>{await cleanup();save();console.log(JSON.stringify({ok:result.ok,stage:result.stage,checks:result.checks.length,error:result.error}));process.exit(result.ok?0:1)});
