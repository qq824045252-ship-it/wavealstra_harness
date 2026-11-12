import assert from "node:assert/strict"; import { execFileSync } from "node:child_process";
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync } from "node:fs";
import { join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app,BrowserWindow,ipcMain } from "electron";
import { AgentIpc } from "../src/shared/agent-ipc";
const output=resolve("out/diagnostics/browser-stop-ui");mkdirSync(output,{recursive:true});
const home=mkdtempSync(join(output,"run-")),config=join(home,".mybuddy"),workspace=join(home,"workspace");mkdirSync(config);mkdirSync(workspace);
process.env.HOME=home;process.env.USERPROFILE=home;process.env.PI_CODING_AGENT_DIR=config;app.setPath("home",home);app.setPath("userData",join(home,"chromium"));app.on("window-all-closed",()=>{});
const modelConfig={id:"stop",name:"controlled stop fixture",reasoning:false,input:["text"],contextWindow:128000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
writeFileSync(join(config,"models.json"),JSON.stringify({providers:{fixture:{api:"openai-completions",baseUrl:"http://127.0.0.1:1",apiKey:"isolated",models:[modelConfig]}}}));
writeFileSync(join(config,"auth.json"),"{}");writeFileSync(join(config,"settings.json"),JSON.stringify({defaultProvider:"fixture",defaultModel:"stop",defaultModelId:"fixture/stop",enabledModels:["fixture/stop"],permissionMode:"auto",memoryEnabled:false,memorySemanticEnabled:false,retry:{enabled:false}}));
mkdirSync(join(config,"plugins/mcp"),{recursive:true});writeFileSync(join(config,"plugins/mcp/mcp.json"),'{"mcpServers":{}}');
let agent:any,db:any,host:any,win:BrowserWindow|undefined;const report:any={sourceVersion:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),scope:"actual ChatInput button and store action, production preload IPC, AgentService, Durable and real renderer; controlled provider; isolated profile"};
const guard=setTimeout(()=>{report.timeout=true;writeFileSync(join(output,"result.json"),JSON.stringify(report,null,2));app.exit(1)},90000);
void(async()=>{
 await app.whenReady();
 const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");
 const {createAssistantMessageEventStream}=await import("@earendil-works/pi-ai/compat");
 const {AgentService}=await import("../src/main/agent/AgentService");
 const {AppDatabase}=await import("../src/main/db/AppDatabase");
 const {TaskExecutionWorkspace}=await import("../src/main/task/TaskExecutionWorkspace");
 const {browserHost}=await import("../src/main/browser/BrowserHost");host=browserHost;
 const {BrowserAutomationService}=await import("../src/main/capabilities/BrowserAutomationService");
 const {CronService}=await import("../src/main/cron/CronService");
 const {TerminalHost}=await import("../src/main/terminal/TerminalHost");
 const {TaskTerminalService}=await import("../src/main/terminal/TaskTerminalService");
 const {createArtifactDomain}=await import("../src/main/artifact/ArtifactDomainSetup");
 const runtime=await ModelRuntime.create({authPath:join(config,"auth.json"),modelsPath:join(config,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
 const page=join(home,"page.html");writeFileSync(page,"<p>stop target</p>");
 runtime.registerProvider("fixture",{api:"openai-completions",apiKey:"isolated",baseUrl:"http://127.0.0.1:1",models:[modelConfig] as any,streamSimple:(model:any)=>{
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:"done",reason:"toolUse",message:{role:"assistant",content:[{type:"toolCall",id:"ui-stop-read",name:"codemode",arguments:{code:`await tools.browser_exec({action:"navigate",url:${JSON.stringify(pathToFileURL(page).href)}});await tools.browser_exec({action:"read"});text("unexpected after stop");`}}],stopReason:"toolUse",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}} as any);stream.end();});return stream;
 }});
 win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{preload:resolve("out/tests/browser-stop-ui-preload.cjs"),contextIsolation:true,sandbox:false}});
 win.webContents.on("console-message",event=>{if(event.level==="error")console.error("renderer",event.message)});
 await win.loadURL("about:blank");host.attach(win);
 db=new AppDatabase(join(config,"app.db"));agent=new AgentService(db,new TaskExecutionWorkspace(join(home,"tasks")),{models:runtime});
 const terminal=new TerminalHost({resolveCwd:()=>workspace});const cron=new CronService(db,agent);agent.setLocalWorkflowServices({cron,terminal:new TaskTerminalService(terminal)});
 const artifacts=createArtifactDomain(db.connection);agent.setArtifactDomain(artifacts.service,artifacts.coordinator);await agent.init();
 ipcMain.handle(AgentIpc.getModeProfile,(_e,id)=>agent.getModeProfile(id));
 ipcMain.handle(AgentIpc.getAppSettings,()=>agent.getAppSettings());
 ipcMain.handle(AgentIpc.abort,async(_e,taskId)=>{report.ipcTaskId=taskId;report.ipcAt=Date.now();await agent.abort(taskId);report.abortReturnedAt=Date.now()});
 ipcMain.handle(AgentIpc.loadTaskHistory,async(_e,taskId,before)=>{const history=await agent.loadTaskHistory(taskId,before);report.historyReturnedAt=Date.now();report.historyBusy=history.durable?.busy;return history;});
 let entered!:()=>void,settled!:()=>void;const started=new Promise<void>(r=>entered=r),finished=new Promise<void>(r=>settled=r);
 const real=BrowserAutomationService.prototype.execute;
 BrowserAutomationService.prototype.execute=async function(input,signal,context){
  if(input.action!=="read")return real.call(this,input,signal,context);
  const tab=host.getTabsState().tabs.find((t:any)=>t.url===pathToFileURL(page).href);assert(tab);
  const wc=host.getTabHost(tab.id).inspectionWebContents;
  void wc.executeJavaScript("(()=>{const end=Date.now()+30000;while(Date.now()<end){};return true})()").catch(()=>{});
  await new Promise(r=>setTimeout(r,100));entered();
  try{return await real.call(this,{...input,timeoutMs:20000},signal,context)}catch(e){report.signalAborted=signal?.aborted;report.toolError=String(e);throw e}finally{report.toolSettledAt=Date.now();settled()}
 };
 const taskId="isolated-ui-stop";db.upsertTask({id:taskId,title:"stop acceptance",updatedAt:Date.now(),welcomeMode:"working",modelId:"fixture/stop",modePresetId:"codemode"});
 const admission=await agent.prompt({taskId,text:"Use browser to read the test page.",assistantMessageId:"stop-assistant",userMessageId:"stop-user",permissionMode:"auto",modelId:"fixture/stop",welcomeMode:"working",modePresetId:"codemode"});assert(!admission.error,JSON.stringify(admission));
 await started;const history=await agent.loadTaskHistory(taskId);assert(history.durable?.busy,"actual task should still be running");
 const bundle=readFileSync(resolve("out/tests/browser-stop-ui-fixture.js"),"utf8");
 assert(await win.webContents.executeJavaScript(bundle+`\nBrowserStopUi.mount(${JSON.stringify(taskId)},${JSON.stringify(history.durable)})`));
 const rect=await win.webContents.executeJavaScript('(()=>{const r=document.querySelector("button[aria-label=\\\"停止生成\\\"]").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 report.clickedAt=Date.now();win.webContents.sendInputEvent({type:"mouseDown",button:"left",clickCount:1,...rect});win.webContents.sendInputEvent({type:"mouseUp",button:"left",clickCount:1,...rect});
 await Promise.race([finished,new Promise((_,reject)=>setTimeout(()=>reject(Error("UI stop did not terminate browser wait")),5000))]);
 const until=Date.now()+10000;while(!report.abortReturnedAt||!report.historyReturnedAt){if(Date.now()>until)throw Error("stop IPC/history did not finish");await new Promise(r=>setTimeout(r,50));}
 while(!await win.webContents.executeJavaScript("BrowserStopUi.stopped()")){if(Date.now()>until)throw Error("renderer did not apply stopped snapshot");await new Promise(r=>setTimeout(r,25));} report.rendererStopped=true;
 assert.equal(report.historyBusy,false); assert.equal(report.ipcTaskId,taskId);assert.equal(report.signalAborted,true);assert.match(report.toolError,/Abort|取消/);report.passed=true;report.electron=process.versions.electron;
 writeFileSync(join(output,"result.json"),JSON.stringify(report,null,2));console.log("PASS",JSON.stringify(report));
})().catch(e=>{report.error=String(e);writeFileSync(join(output,"result.json"),JSON.stringify(report,null,2));console.error(e);process.exitCode=1}).finally(()=>{agent?.dispose();host?.dispose();win?.destroy();db?.close();clearTimeout(guard);app.exit(process.exitCode?1:0)});





