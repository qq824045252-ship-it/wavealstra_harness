import fs from 'node:fs';
const targets=await (await fetch('http://127.0.0.1:9229/json/list')).json();const target=targets.find(t=>t.title.includes('MyBuddy.exe[47944]'));
if(!target)throw new Error('Unexpected inspector target');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
try{
 const e=await call('Runtime.evaluate',{expression:'JSON.stringify({pid:process.pid,require:typeof require,mainModule:!!process.mainModule,handlers:typeof require==="function"?require("electron").ipcMain._invokeHandlers.size:null})',returnByValue:true});console.log(JSON.stringify(e));
 const f=await call('Runtime.evaluate',{expression:'process.mainModule.require("electron").ipcMain._invokeHandlers.get("agent:prompt")',returnByValue:false});
 if(f.result?.objectId){
  const props=await call('Runtime.getProperties',{objectId:f.result.objectId,ownProperties:false});
  const scopes=props.internalProperties?.find(p=>p.name==='[[Scopes]]');
  if(scopes?.value?.objectId){
   const list=await call('Runtime.getProperties',{objectId:scopes.value.objectId,ownProperties:true});
   const safe=[];
   for(const p of list.result??[]){if(p.value?.objectId&&p.name!=='__proto__'){
    const scope=await call('Runtime.getProperties',{objectId:p.value.objectId,ownProperties:true});
    const entry=scope.result?.find(x=>x.name==='agentService');safe.push({scope:p.name,description:p.value.description,names:scope.result?.map(x=>x.name),hasAgentService:!!entry});
    if(entry?.value?.objectId){
      // Retain a private, temporary diagnostic handle without serializing the service.
      const result=await call('Runtime.callFunctionOn',{objectId:entry.value.objectId,functionDeclaration:'function(){globalThis.__cacheInvestigationService=this;return {busy:this.isTaskBusy("local-1793579906915-0"),serviceKeys:Object.keys(this).filter(k=>/registry|model|session/i.test(k))};}',returnByValue:true});console.log(JSON.stringify({service:result}));
    }
   }}
   console.log(JSON.stringify({scopes:safe}));
  }
 }
}finally{ws.close();}
