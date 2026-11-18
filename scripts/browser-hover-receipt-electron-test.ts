import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import { pageInspectionService } from "../src/main/artifact/PageInspectionService";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService, BrowserAutomationError } from "../src/main/capabilities/BrowserAutomationService";
const root=mkdtempSync(join(tmpdir(),"hover-receipt-"));app.setPath("userData",join(root,"profile"));app.setPath("home",root);app.on("window-all-closed",()=>{});
const guard=setTimeout(()=>app.exit(1),40000);
void(async()=>{let host:BrowserHost|undefined,win:BrowserWindow|undefined;try{
await app.whenReady();win=new BrowserWindow({show:false,width:1000,height:800});await win.loadURL("data:text/html,test");host=new BrowserHost();host.attach(win);const service=new BrowserAutomationService(()=>host??null);const context={taskId:"hover-fixture",taskRoot:root};const url=pathToFileURL(join(process.cwd(),"scripts/browser-hover-menu-fixture.html")).href;
{
 const opened=await service.execute({action:"navigate",url,reload:true},undefined,context),tabId=opened.tabId!;
 const wc=host.getTabHost(tabId)!.inspectionWebContents!;
 await wc.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<textarea id="spa-submit"></textarea>');window.submissions=0;document.querySelector('#spa-submit').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();window.submissions++;history.pushState({},'',location.pathname+'?chat=submitted');}};true`);
 await service.execute({action:"find",tabId,selector:"#spa-submit"},undefined,context);
 const original=wc.executeJavaScript.bind(wc);
 // Delay only the host delivery of the real renderer receipt. Native key events
 // and the SPA handler run normally, matching a navigation-before-ack race.
 wc.executeJavaScript=async(code,...args)=>{
   const value=await original(code,...args);
   if(code.includes('window.__mybuddyInputReceipts.get('))await new Promise(resolve=>setTimeout(resolve,60));
   return value;
 };
 try {
   const submitted=await service.execute({action:"press",tabId,selector:"#spa-submit",key:"Enter"},undefined,context);
   assert.deepEqual(submitted.outcome,{dispatch:"dispatched",effect:"confirmed"});
 } finally { wc.executeJavaScript=original; }
 assert.equal(await original("window.submissions"),1,"receipt reconciliation must not replay a submission");
 assert(wc.getURL().includes('chat=submitted'));
}
for (const scenario of ["lost-receipt", "cancelled"] as const) {
 const opened=await service.execute({action:"navigate",url,reload:true},undefined,context),tabId=opened.tabId!;
 const wc=host.getTabHost(tabId)!.inspectionWebContents!;
 await wc.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<textarea id="guarded-submit"></textarea>');window.submissions=0;document.querySelector('#guarded-submit').onkeydown=e=>{if(e.key==='Enter'){window.submissions++;history.pushState({},'',location.pathname+'?guarded');}};true`);
 await service.execute({action:"find",tabId,selector:"#guarded-submit"},undefined,context);
 const original=wc.executeJavaScript.bind(wc),controller=new AbortController();
 wc.executeJavaScript=async(code,...args)=>{
   const value=await original(code,...args);
   if(code.includes('window.__mybuddyInputReceipts.get(')){
     if(scenario==="cancelled")controller.abort();
     await new Promise(resolve=>setTimeout(resolve,60));
     return false;
   }
   return value;
 };
 try {
   await assert.rejects(service.execute({action:"press",tabId,selector:"#guarded-submit",key:"Enter"},controller.signal,context),error=>{
     assert(error instanceof Error);
     if(scenario==="cancelled")return error.name==="AbortError";
     return error instanceof BrowserAutomationError&&error.code==="SURFACE_CHANGED";
   },"URL changes alone cannot confirm input without its receipt, or override cancellation");
 } finally { wc.executeJavaScript=original; }
 assert.equal(await original("window.submissions"),1,"uncertainty and cancellation never trigger an automatic second submission");
}
{
 const opened=await service.execute({action:"navigate",url,reload:true},undefined,context),tabId=opened.tabId!;
 const wc=host.getTabHost(tabId)!.inspectionWebContents!;
 await wc.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<div id="custom-login">登录</div>');window.loginClicks=0;document.querySelector('#custom-login').onclick=()=>{window.loginClicks++;};true`);
 await service.execute({action:"read",tabId},undefined,context);
 await assert.rejects(service.execute({action:"click",tabId,name:"登录",exact:true},undefined,context),error=>error instanceof BrowserAutomationError&&error.code==="SURFACE_CHANGED");
 assert.equal(await wc.executeJavaScript("window.loginClicks"),0,"an unobserved custom control never receives input");
 const found=await service.execute({action:"find",tabId,name:"登录",exact:true},undefined,context),login=found.elements?.[0];assert(login);
 assert.match(login.selector,/^\[data-mybuddy-ui-ref="mb-[a-zA-Z0-9-]+"\]$/,"host references round-trip without CSS backslash escapes");
 const copied=JSON.parse(JSON.stringify(login.selector));
 const clicked=await service.execute({action:"click",tabId,selector:copied},undefined,context);
 assert.equal(clicked.outcome?.effect,"confirmed");assert.equal(await wc.executeJavaScript("window.loginClicks"),1);
}
{
 const opened=await service.execute({action:"navigate",url,reload:true},undefined,context),tabId=opened.tabId!;
 const wc=host.getTabHost(tabId)!.inspectionWebContents!;await wc.executeJavaScript(`document.querySelector('.nav').insertAdjacentHTML('beforeend','<div class="menu" id="duplicate">账簿</div>');true`);
 let ambiguous: BrowserAutomationError | undefined;
 try{await service.execute({action:"click",tabId,role:"link",name:"凭证汇总表",hover:[{name:"账簿"}]},undefined,context)}catch(error){if(error instanceof BrowserAutomationError)ambiguous=error;else throw error;}
 assert.equal(ambiguous?.code,"ELEMENT_AMBIGUOUS");
 const details=ambiguous?.details;assert(details&&typeof details==="object"&&"candidates" in details&&Array.isArray(details.candidates));
 const candidate=details.candidates.find(c=>c.tag==="div"&&c.bounds.x===40&&c.label.includes("账簿"));assert(candidate);
 const fixed=await service.execute({action:"click",tabId,role:"link",name:"凭证汇总表",exact:true,hover:[{selector:candidate.selector}]},undefined,context);assert.equal(fixed.outcome?.effect,"confirmed");
}
for(let i=0;i<8;i++){
 const opened=await service.execute({action:"navigate",url,reload:true},undefined,context);const tabId=opened.tabId!;
 const found=await service.execute({action:"find",tabId,selector:"div.menu"},undefined,context);const anchor=found.elements?.find(el=>el.label.includes("账簿"));assert(anchor);
 const result=await service.execute({action:"click",tabId,role:"link",name:"凭证汇总表",exact:true,hover:[i%2?{name:"账簿"}:{selector:anchor.selector}],after:{selector:"#out",mode:"text"}},undefined,context);
 assert.deepEqual(result.outcome,{dispatch:"dispatched",effect:"confirmed"});assert.equal(result.observation?.status,"completed");assert.match(result.observation.status==="completed"?result.observation.result.text??"":"",/已点击：凭证汇总表/);
}
{
 const opened=await service.execute({action:"navigate",url,reload:true},undefined,context),tabId=opened.tabId!;
 const wc=host.getTabHost(tabId)!.inspectionWebContents!;
 await wc.executeJavaScript(`document.querySelector('.sub').insertAdjacentHTML('beforeend','<button id="decoy">无关控件</button>');true`);
 const found=await service.execute({action:"find",tabId,selector:"div.menu"},undefined,context),anchor=found.elements?.find(el=>el.label.includes("账簿"));assert(anchor);
 const session=pageInspectionService.sessionFor(wc,"browser-host")!;const original=session.inputCommand.bind(session);let injected=false;
 session.inputCommand=async(method,params)=>{
   if(!injected&&method==="Input.dispatchMouseEvent"&&params.type==="mousePressed"){
     injected=true;const p=await wc.executeJavaScript(`(()=>{const r=document.querySelector('#decoy').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
     await original(method,{type:"mousePressed",...p,button:"left",buttons:1,clickCount:1});
     await original(method,{type:"mouseReleased",...p,button:"left",buttons:0,clickCount:1});
   }
   await original(method,params);
 };
 try {const clicked=await service.execute({action:"click",tabId,role:"link",name:"凭证汇总表",exact:true,hover:[{selector:anchor.selector}]},undefined,context);assert.equal(clicked.outcome?.effect,"confirmed");}
 finally{session.inputCommand=original;}
 assert(injected);assert.match(await wc.executeJavaScript("document.querySelector('#out').textContent"),/已点击：凭证汇总表/);
}
console.log("PASS SPA submit receipt after navigation, lost-receipt/cancellation no-replay, custom-control refs, candidate correction, 8 hover/clicks and trusted-event interference");host.dispose();win.destroy();clearTimeout(guard);app.exit(0);
}catch(error){console.error(error);host?.dispose();win?.destroy();clearTimeout(guard);app.exit(1)}})();
