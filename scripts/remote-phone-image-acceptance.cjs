/** Real-phone, read-only acceptance for the existing generated PNG task. No prompts or token changes. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const serial=process.env.ADB_SERIAL||'A4UF6R6206002786';
const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
const taskId=process.env.REMOTE_TEST_TASK_ID||'remote-84c7877a-5396-4d7e-8db1-8932cba5c42d';
const expectedPath=process.env.REMOTE_TEST_IMAGE||path.join(os.homedir(),'.mybuddy/task-workspaces',taskId+'--0ea8f974470c7c91/generated/image/da7f63d6-gpt-image-2-1.png');
const reportDir=path.join(root,'artifacts/remote-images-20260930');fs.mkdirSync(reportDir,{recursive:true});
const result={ok:false,at:new Date().toISOString(),checks:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let port,ws,seq=0;const pending=new Map(),requests=new Map(),imageReads=[],historyReads=[],bodyJobs=[];
function run(args){const r=spawnSync(adb,['-s',serial,...args],{encoding:'utf8',windowsHide:true,timeout:10000});if(r.status!==0)throw Error('ADB '+args.slice(0,3).join(' ')+': '+String(r.error||r.stderr||r.stdout));return r.stdout.trim()}
function send(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.result?.description||r.exceptionDetails.text);return r.result?.value}
async function until(expression,ms=18000){const start=Date.now();while(Date.now()-start<ms){const value=await evaluate(expression);if(value)return value;await pause(200)}throw Error('Phone condition not met: '+expression.slice(0,160))}
function check(name,ok,details){result.checks.push({name,ok,...(details?{details}:{})});if(!ok)throw Error(name);console.log('PASS '+name)}
(async()=>{
 const metadata=JSON.parse(fs.readFileSync('app/remote/android/app/build/outputs/apk/debug/output-metadata.json','utf8')).elements[0];
 const installed=run(['shell','dumpsys','package','com.mybuddy.remote']);
 check('latest built Android package is actually installed',new RegExp('versionCode='+metadata.versionCode+'\\b').test(installed),{versionName:metadata.versionName,versionCode:metadata.versionCode});
 const pid=run(['shell','pidof','com.mybuddy.remote']).split(/\s+/)[0];
 const socket=run(['shell','cat','/proc/net/unix']).split(/\r?\n/).find(l=>l.includes('@webview_devtools_remote_'+pid))?.split('@').at(-1);
 if(!socket)throw Error('Current WebView not available');
 port=Number(run(['forward','tcp:0','localabstract:'+socket]));
 const targets=await(await fetch('http://127.0.0.1:'+port+'/json')).json();const target=targets.find(t=>t.type==='page'&&t.url.startsWith('https://localhost'));
 if(!target)throw Error('Remote application WebView not found');
 ws=new WebSocket(target.webSocketDebuggerUrl);
 ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}return}
  if(m.method==='Network.responseReceived'){const r=m.params.response;let u;try{u=new URL(r.url)}catch{return}if(u.protocol!=='https:'||!u.hostname.endsWith('.ts.net')||r.status!==200)return;
   if(u.pathname===`/v1/tasks/${taskId}/history`||u.pathname.startsWith(`/v1/tasks/${taskId}/artifacts/`))requests.set(m.params.requestId,{path:u.pathname,queryKeys:[...u.searchParams.keys()],mime:r.mimeType});}
  if(m.method==='Network.loadingFinished'&&requests.has(m.params.requestId)){
   const record=requests.get(m.params.requestId);requests.delete(m.params.requestId);
   const job=send('Network.getResponseBody',{requestId:m.params.requestId}).then(body=>{
    const bytes=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');
    if(record.path.endsWith('/history')){const h=JSON.parse(bytes.toString('utf8'));historyReads.push({images:h.imageArtifacts||[],messageImageCounts:h.messages.map(x=>(x.artifacts||[]).filter(a=>a.kind==='image').length)});}
    else imageReads.push({...record,devtoolsBodyAvailable:bytes.length>0,...(bytes.length?{devtoolsBytes:bytes.length,devtoolsSha256:sha(bytes)}:{})});
   }).catch(error=>{result.bodyReadError=String(error)});bodyJobs.push(job);
  }
 };
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 await send('Network.enable',{maxTotalBufferSize:30000000,maxResourceBufferSize:18000000});
 await until('!!document.querySelector(".claude-header")');
 check('existing pairing is authenticated',true);
 const hasDraft=await evaluate('!!document.querySelector("textarea")?.value');if(hasDraft)throw Error('Unsent draft exists; refusing to overwrite or navigate away');
 if(!(await evaluate('document.querySelector(".header-title-chat")?.textContent.includes("帮我生图")'))){
  await evaluate('document.querySelector("button[aria-label=菜单]")?.click()');await pause(200);
  const found=await evaluate(`(()=>{const b=[...document.querySelectorAll('.drawer-item-btn')].find(b=>b.textContent.includes('帮我生图，一周锻炼计划'));b?.click();return !!b})()`);
  if(!found)throw Error('Existing generated-image task not found in drawer');
 }
 await until('document.querySelector(".header-title-chat")?.textContent.includes("帮我生图")');
 // Finish the initial navigation first; Page.reload returns before navigation commits.
 await until('document.querySelectorAll(".chat-timeline .remote-artifact-image").length >= 2 && [...document.querySelectorAll(".chat-timeline .remote-artifact-image")].every(i=>i.complete && i.naturalWidth>0)',25000);
 await pause(300);await Promise.all([...bodyJobs]);
 await evaluate('window.__imageReloadMarker = true');
 imageReads.length=0;historyReads.length=0;requests.clear();
 await send('Page.reload',{ignoreCache:true});
 await until('!window.__imageReloadMarker && !!document.querySelector(".claude-header")');
 await until('document.querySelectorAll(".chat-timeline .remote-artifact-image").length >= 2 && [...document.querySelectorAll(".chat-timeline .remote-artifact-image")].every(i=>i.complete && i.naturalWidth>0)',25000);
 await pause(500);await Promise.all([...bodyJobs]);
 const images=await evaluate('[...document.querySelectorAll(".chat-timeline .remote-artifact-image")].map(i=>({width:i.naturalWidth,height:i.naturalHeight,blob:i.src.startsWith("blob:"),id:i.closest("[data-artifact-id]").dataset.artifactId}))');
 check('both original Windows-path references display the generated PNG',images.length===2&&images.every(i=>i.width===1536&&i.height===1024&&i.blob),{images});
 const bytes=fs.readFileSync(expectedPath);const expectedSha=sha(bytes);
 const displayedBytes=await evaluate(`(async()=>{const r=await fetch(document.querySelector('.remote-artifact-image').src);const b=await r.arrayBuffer();const hash=await crypto.subtle.digest('SHA-256',b);return {bytes:b.byteLength,sha256:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('')}})()`);
 result.downloads=imageReads;
 check('HTTPS image bytes match the existing PC file exactly',imageReads.length===1&&displayedBytes.sha256===expectedSha&&displayedBytes.bytes===bytes.length,{bytes:bytes.length,sha256:expectedSha,downloads:imageReads.length,displayedBytes});
 check('image URLs contain no credential or disk-path parameters',imageReads.every(x=>x.queryKeys.every(k=>k==='v')));
 check('history includes registered-image metadata and reply provenance',historyReads.some(h=>h.images.length===1&&h.messageImageCounts.some(n=>n===1)));
 await evaluate(`(()=>{window.__imageAcceptanceNodes=[...document.querySelectorAll('.chat-timeline .remote-artifact-image')];window.__imageAcceptanceUrls=window.__imageAcceptanceNodes.map(n=>n.src);window.__imageAcceptanceNodes.at(-1).scrollIntoView({block:'center'});})()`);
 await pause(300);const before=await evaluate('document.querySelector(".chat-timeline").scrollTop'),readCount=historyReads.length;
 await pause(15500);await Promise.all([...bodyJobs]);
 const stable=await evaluate(`({same:window.__imageAcceptanceNodes.every((n,i)=>n.isConnected&&n.src===window.__imageAcceptanceUrls[i]&&n.naturalWidth===1536),y:document.querySelector('.chat-timeline').scrollTop,openTools:document.querySelectorAll('.process-panel.open,.claude-tool-card.open').length})`);
 check('automatic history refresh preserves images, scroll position and collapsed tools',stable.same&&Math.abs(stable.y-before)<2&&stable.openTools===0&&historyReads.length>readCount,{drift:stable.y-before,freshReads:historyReads.length-readCount,downloads:imageReads.length});
 check('duplicate images and background refresh share one binary download',imageReads.length===1);
 await evaluate('document.querySelector(".remote-image-open").click()');
 await until('document.querySelector(".remote-image-viewer img")?.naturalWidth===1536');
 check('original-image viewer displays the same full-resolution image',true);
 await evaluate('document.querySelector("button[aria-label=关闭原图]").click()');
 await until('!document.querySelector(".remote-image-viewer")');
 result.source={bytes:bytes.length,sha256:expectedSha};result.downloads=imageReads;result.ok=true;
})().catch(error=>{result.error=String(error);console.error(error.stack);process.exitCode=1}).finally(async()=>{
 try{if(ws?.readyState===1)await evaluate('delete window.__imageAcceptanceNodes;delete window.__imageAcceptanceUrls')}catch{}
 ws?.close();for(const p of pending.values())clearTimeout(p.timer);pending.clear();
 if(port)try{run(['forward','--remove','tcp:'+port]);result.debugForwardCleaned=true}catch{}
 fs.writeFileSync(path.join(reportDir,'phone-image-acceptance.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:result.ok,passed:result.checks.filter(c=>c.ok).length,error:result.error,report:'artifacts/remote-images-20260930/phone-image-acceptance.json'}));
});
