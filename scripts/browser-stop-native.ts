import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path"; import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import { Type } from "typebox";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
const root=mkdtempSync(join(process.cwd(),"out/diagnostics/stop-native-")); app.setPath("userData",join(root,"profile")); app.setPath("home",root); app.on("window-all-closed",()=>{});
const guard=setTimeout(()=>app.exit(1),60000);
void (async()=>{
 await app.whenReady();
 const win=new BrowserWindow({show:false}); await win.loadURL("data:text/html,stop fixture");
 const host=new BrowserHost(); host.attach(win); const browser=new BrowserAutomationService(()=>host);
 writeFileSync(join(root,"page.html"),"<p>busy stop</p>"); const target=await browser.execute({action:"navigate",url:pathToFileURL(join(root,"page.html")).href},undefined,{taskId:"stop-native"});
 const wc=host.getTabHost(target.tabId!)!.inspectionWebContents!;
 let entered!:()=>void, settled!:()=>void, signalAborted=false, toolError="";
 const toolStarted=new Promise<void>(r=>entered=r),toolSettled=new Promise<void>(r=>settled=r);
 const bridge=await durableDomainTools([api=>{api.registerTool({name:"browser_exec",label:"Real browser stop test",description:"read page",parameters:Type.Object({action:Type.String()}),execute:async(_id,args,signal)=>{
    void wc.executeJavaScript("(()=>{const until=Date.now()+4000;while(Date.now()<until){};return true})()").catch(()=>{});
    await new Promise(r=>setTimeout(r,100)); entered();
    try { const details=await browser.execute({action:"read",tabId:target.tabId,timeoutMs:10000},signal,{taskId:"stop-native"});return {content:[{type:"text",text:JSON.stringify(details)}],details};}
    catch(e){signalAborted=Boolean(signal?.aborted);toolError=String(e);throw e;}finally{settled();}
 }});}]);
 const model=await ModelRuntime.create({authPath:join(root,"auth.json"),modelsPath:null,modelsStorePath:join(root,"catalog.json"),refreshOnCreate:false});
 model.registerProvider("fixture",{api:"openai-completions",apiKey:"isolated",baseUrl:"http://127.0.0.1:1",models:[{id:"model",name:"stop fixture",reasoning:false,input:["text"],contextWindow:128000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple:(model)=>{
 const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:"done",reason:"toolUse",message:{role:"assistant",content:[{type:"toolCall",id:"stop-read",name:"codemode",arguments:{code:"const result=await tools.browser_exec({action:'read'});text(result);"}}],stopReason:"toolUse",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});stream.end();});return stream;}});
 mkdirSync(join(root,"state"));
 const runtime=await DurableBotRuntime.open({taskId:"stop-native",cwd:root,directory:join(root,"state"),models:model,model:{provider:"fixture",modelId:"model"},toolMode:"codemode",tools:bridge.tools,instructions:()=>"Run browser read once",onSnapshot:()=>{}});
 try{await runtime.submit("read", "stop-input");await toolStarted;const began=Date.now();await runtime.abort();await Promise.race([toolSettled,new Promise((_,reject)=>setTimeout(()=>reject(Error("tool failed to settle")),2000))]);assert(signalAborted,toolError);assert.match(toolError,/Abort|取消/);assert(Date.now()-began<2500);const report={passed:true,elapsedMs:Date.now()-began,signalAborted,toolError,scope:"real DurableBotRuntime.abort -> Pi codemode -> DurableDomainTools signal -> real Electron renderer wait; controlled model; not UI click",electron:process.versions.electron};writeFileSync(join(root,"result.json"),JSON.stringify(report,null,2));console.log("PASS",JSON.stringify(report));await new Promise(r=>setTimeout(r,4500));}finally{await runtime.close();host.dispose();win.destroy();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{clearTimeout(guard);app.exit(process.exitCode?1:0);});

