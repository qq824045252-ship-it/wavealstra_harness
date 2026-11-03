/** Actual packaged host + preload IPC + local Responses server. Hidden, isolated profile. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const exe=path.resolve(process.argv[2]||'');assert(process.argv[2]&&fs.existsSync(exe),'Pass the actual packaged executable');
const subagentMode=process.argv.includes('--subagent');
const root=path.resolve(__dirname,'..'),out=path.join(root,'out/tests',subagentMode?'subagent-cache-trace-packaged':'cache-trace-packaged');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'mybuddy-cache-trace-'));
const agent=path.join(profile,'.mybuddy');for(const p of [agent,path.join(agent,'plugins'),path.join(profile,'appdata'),path.join(profile,'localappdata')])fs.mkdirSync(p,{recursive:true});
const report={status:'running',startedAt:new Date().toISOString(),profile,exe,requests:0};const bodies=[];
const marker='CACHE_CONTENT_CANARY';const apiKey='local-trace-fixture-only';
let mainCalls=0,childCalls=0;const fixtureFile=path.join(profile,'fixture.txt');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer(async(req,res)=>{try{
  assert(req.method==='POST'&&req.url.endsWith('/responses'));
  const chunks=[];for await(const x of req)chunks.push(x);const body=JSON.parse(Buffer.concat(chunks));
  assert(JSON.stringify(body.input).includes(marker),'Unexpected model operation');bodies.push(body);const n=++report.requests;
  const isChild=subagentMode&&String(body.prompt_cache_key??'').startsWith('reviewer-');
  const sequence=isChild?++childCalls:++mainCalls;
  const cached=subagentMode?(isChild?[0,99000,0][sequence-1]:[0,99000][sequence-1]):[0,99000,25000][n-1];assert(cached!==undefined,'Unexpected extra request');
  let output=[{type:'message',id:'msg_trace_'+n,role:'assistant',status:'completed',content:[{type:'output_text',text:'ACK',annotations:[]}]}];
  if(subagentMode&&(!isChild&&sequence===1||isChild&&sequence<3)){
    output=[{type:'function_call',id:'fc_'+n,call_id:'call_'+n,name:isChild?'read':'subagent',
      arguments:JSON.stringify(isChild?{path:fixtureFile,offset:1,limit:5}:{agent:'reviewer',task:marker+' Review only '+fixtureFile,agentScope:'user'})}];
  }
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const item of output){res.write('data: '+JSON.stringify({type:'response.output_item.added',output_index:0,item})+'\n\n');res.write('data: '+JSON.stringify({type:'response.output_item.done',output_index:0,item})+'\n\n')}
  res.end('data: '+JSON.stringify({type:'response.completed',response:{id:'resp_packaged_trace_'+n,model:'trace-fixture',status:'completed',
    output,
    usage:{input_tokens:100000,output_tokens:2,input_tokens_details:{cached_tokens:cached}}}})+'\n\n');
}catch(error){report.serverError=error.message;res.writeHead(500);res.end('{}')}});
let child,ws,exited=false,paused=false,callFrame;const pending=new Map();let sequence=0;
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector timeout: '+method))},40000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function atBreakpoint(expression){const r=await rpc('Debugger.evaluateOnCallFrame',{callFrameId:callFrame,expression,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function renderer(expression){return evaluate(`globalThis.traceWindow.webContents.executeJavaScript(${JSON.stringify(expression)})`)}
(async()=>{try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  fs.writeFileSync(path.join(agent,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-responses',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey,
    models:[{id:'trace-fixture',name:'Trace fixture',reasoning:false,input:['text'],contextWindow:500000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
  fs.writeFileSync(path.join(agent,'auth.json'),'{}');fs.writeFileSync(path.join(agent,'plugins/mcp.json'),'{"mcpServers":{}}');
  if(subagentMode){
    fs.mkdirSync(path.join(agent,'plugins/agents'),{recursive:true});
    fs.writeFileSync(path.join(agent,'plugins/agents/reviewer.md'),'---\nname: reviewer\ndescription: Local fixture reviewer\ntools: read\n---\nReview only the file named by the task.');
    fs.writeFileSync(fixtureFile,marker+'\n'+('fixture line\n'.repeat(10)));
  }
  fs.writeFileSync(path.join(agent,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'trace-fixture',enabledModels:['fixture/trace-fixture'],memoryEnabled:false,memoryGatewayEnabled:false,remoteAccessEnabled:false,closeToTray:false,proxyUrl:''}));
  const capabilities={schemaVersion:1,execution:{terminalEnabled:false,codeExecutionEnabled:false}};
  for(const key of ['web','vision','imageGeneration','videoGeneration','speechToText','textToSpeech','browser','diagnostics','subagent','multiModelConsult'])capabilities[key]={enabled:false};
  if(subagentMode)capabilities.subagent={enabled:true};
  fs.writeFileSync(path.join(agent,'capabilities.json'),JSON.stringify(capabilities));
  const debug=await freePort();const env={...process.env,HOME:profile,USERPROFILE:profile,APPDATA:path.join(profile,'appdata'),LOCALAPPDATA:path.join(profile,'localappdata'),PI_CODING_AGENT_DIR:agent};
  delete env.ELECTRON_RUN_AS_NODE;for(const k of Object.keys(env))if(/^MYBUDDY_/i.test(k))delete env[k];
  env.MYBUDDY_PERF_STARTUP='1';env.MYBUDDY_CACHE_TRACE='1';
  const log=fs.openSync(path.join(out,'desktop.log'),'w');
  child=spawn(exe,[`--inspect-brk=127.0.0.1:${debug}`,`--user-data-dir=${path.join(profile,'chromium')}`],{cwd:profile,env,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);
  report.childPid=child.pid;fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));
  child.on('exit',()=>{exited=true});
  let target;for(let i=0;i<150;i++){if(exited)throw Error('Desktop exited');try{target=(await fetch(`http://127.0.0.1:${debug}/json/list`).then(r=>r.json())).find(t=>t.type==='node')}catch{}if(target)break;await wait(200)}assert(target,'Inspector missing');
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.method==='Debugger.paused'){paused=true;callFrame=m.params.callFrames[0].callFrameId}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)};
  report.phase='startup-breakpoint';
  await rpc('Runtime.enable');await rpc('Debugger.enable');await rpc('Runtime.runIfWaitingForDebugger');
  for(let i=0;i<150&&!paused;i++)await wait(100);assert(paused,'Initial application breakpoint missing');
  assert.equal(await atBreakpoint('process.pid'),child.pid,'Only inspect the test process');
  // PERF_STARTUP keeps the window hidden. Suppress only its auto-exit callback in this test process.
  // Paused V8 frames cannot drain the microtasks required by Runtime.evaluate(awaitPromise).
  await atBreakpoint(`(()=>{const write=process.stdout.write;process.stdout.write=function(chunk,...args){return String(chunk).startsWith('MYBUDDY_PERF_STARTUP:')?write.call(this,chunk):write.call(this,chunk,...args)};return true})()`);
  await rpc('Debugger.resume');report.phase='desktop-startup';
  let ready=false;for(let i=0;i<180;i++){
    if(exited)throw Error('Desktop exited before ready');
    ready=await evaluate(`(()=>{if(!process.mainModule)return false;const {app,BrowserWindow}=process.mainModule.require('electron');if(!app.isReady())return false;globalThis.traceWindow=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('out/renderer/index.html')&&!w.webContents.isLoadingMainFrame());return !!globalThis.traceWindow})()`);
    if(ready)break;await wait(200);
  }assert(ready,'Renderer missing');
  report.identity=await evaluate(`(()=>{const req=process.mainModule.require.bind(process.mainModule),{app}=req('electron');return {version:app.getVersion(),packaged:app.isPackaged,home:req('node:os').homedir(),userData:app.getPath('userData'),visible:globalThis.traceWindow.isVisible()}})()`);
  assert(report.identity.packaged);assert.equal(report.identity.version,JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version);assert.equal(report.identity.home,profile);assert(report.identity.userData.startsWith(profile));assert.equal(report.identity.visible,false);
  await renderer(`window.api.db.upsertTask({id:'cache-trace-acceptance',title:'Cache trace acceptance',updatedAt:Date.now(),cwd:${JSON.stringify(profile)},modelId:'fixture/trace-fixture',permissionMode:'readonly',welcomeMode:'working'})`);
  report.phase='model-prompts';
  for(let n=1;n<=(subagentMode?1:3);n++){
    const r=await renderer(`window.api.agent.prompt(${JSON.stringify({taskId:'cache-trace-acceptance',text:marker+' '+n,modelId:'fixture/trace-fixture',permissionMode:'readonly',userMessageId:'trace-user-'+n,assistantMessageId:'trace-assistant-'+n})})`);
    assert(!r.error,JSON.stringify(r));assert.equal(r.queued,false);
  }
  assert.equal(report.requests,subagentMode?5:3);assert(!report.serverError,report.serverError);
  const chains=new Map();for(const body of bodies){const key=body.prompt_cache_key??'main';const chain=chains.get(key)??[];chain.push(body);chains.set(key,chain)}
  for(const chain of chains.values())for(let i=1;i<chain.length;i++){assert.deepEqual(chain[i].input.slice(0,chain[i-1].input.length),chain[i-1].input);const {input:a,...old}=chain[i-1],{input:b,...next}=chain[i];assert.deepEqual(next,old)}
  const logDir=path.join(agent,'logs');const raw=fs.readdirSync(logDir).filter(n=>/^cache-requests-/.test(n)).map(n=>fs.readFileSync(path.join(logDir,n),'utf8')).join('\n');
  assert(!raw.includes(marker));assert(!raw.includes(apiKey));
  const records=raw.split('\n').filter(l=>l.includes('[cache-trace] ')).map(l=>JSON.parse(l.split('[cache-trace] ')[1]));
  const {summarizeCacheTraces}=await import(require('node:url').pathToFileURL(path.join(root,'scripts/cache-trace-audit.mjs')).href);
  report.trace=summarizeCacheTraces(records);assert.equal(report.trace.calls,subagentMode?5:3);assert.equal(report.trace.classificationCounts['stable-prefix-low-cache'],1);
  assert(report.trace.requests.every(r=>r.adapterMatches.every(v=>v===true)));
  if(subagentMode){
    const host=report.trace.requests.filter(r=>r.source==='main'),children=report.trace.requests.filter(r=>r.source==='subagent');
    assert.equal(host.length,2);assert.equal(children.length,3);assert(children.every(r=>r.parentSessionHash===host[0].sessionHash));
    const archive=fs.readFileSync(path.join(agent,'subagent/usage-archive.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
    assert.equal(archive.length,1);assert.equal(archive[0].usage.turns,3);
    assert.equal(fs.readdirSync(path.join(agent,'subagent/sessions')).length,0,'child history still disposed');
    report.subagent={hostCalls:host.length,childCalls:children.length,disposed:true,parentLinked:true};
  }
  report.asarSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex');
  report.status='passed';console.log(subagentMode?'PASS packaged host + native child: IPC delegation, repeated reads, forced low-cache diagnosis, parent-linked host log survives child cleanup':'PASS packaged host: three IPC prompts, actual HTTP fingerprints, forced low-cache diagnosis, no plaintext, hidden isolated desktop');
  await evaluate(`setTimeout(()=>process.mainModule.require('electron').app.quit(),50);true`);
}catch(error){report.status='failed';report.error=error.stack;console.error(error.stack);process.exitCode=1}
finally{ws?.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Closed'))}for(let i=0;i<40&&!exited;i++)await wait(100);if(child&&!exited)child.kill('SIGTERM');server.closeAllConnections();server.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2))}})();
