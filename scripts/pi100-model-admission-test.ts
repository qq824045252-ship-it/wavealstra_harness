import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { installModelInvocationAdmission, withModelInvocationSettings } from '../src/main/agent/ModelInvocationAdmission';
const results:any[]=[]; const root=mkdtempSync(join(tmpdir(),'pi100-provider-pause-'));let fixtureId=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();results.push({name,status:'passed'});console.log('PASS '+name)}catch(e){results.push({name,status:'failed',error:String(e)});console.error('FAIL '+name+': '+e)}}
function fixture(){
 let sent=0;let beforeHeaders=async()=>{};
 const dir=join(root,String(++fixtureId));mkdirSync(dir);const settingsFile=join(dir,'settings.json');
 const write=(paused=false)=>writeFileSync(settingsFile,JSON.stringify({enabledModels:['fixture/chat'],...(paused?{pausedProviderModels:{fixture:['fixture/chat']}}:{})}));write();
 const settings=SettingsManager.create(dir,dir);
 const image:any={type:'image',provider:'fixture',id:'image',api:'fixture-image'};
 const classifier:any={type:'classifier',provider:'fixture',id:'classifier',api:'fixture-classifier'};
 const runtime:any={stream:()=>{throw Error('unused')},streamSimple:()=>{throw Error('unused')},
  generateImages:async(m:any,c:any,o:any)=>{await beforeHeaders();await o.transformHeaders({});await o.onPayload(c,m);sent++;return {api:m.api,provider:m.provider,model:m.id,output:[],stopReason:'stop',timestamp:Date.now()}},
  classify:async(m:any,c:any,o:any)=>{await beforeHeaders();await o.transformHeaders({});await o.onPayload(c,m);sent++;return {api:m.api,provider:m.provider,model:m.id,answers:{},stopReason:'stop',timestamp:Date.now()}},
 };
 installModelInvocationAdmission(runtime,()=>settings);
 const images=(options:any={})=>runtime.generateImages(image,{input:[]},options);
 const classify=(options:any={})=>runtime.classify(classifier,{state:{},questions:{}},options);
 return {settings,runtime,images,classify,pause:()=>write(true),sent:()=>sent,beforeHeaders:(f:()=>Promise<void>)=>{beforeHeaders=f}};
}
await test('native typed methods use the existing runtime and are not mistaken for chat scope',async()=>{const f=fixture();assert.equal((await f.images()).stopReason,'stop');assert.equal((await f.classify()).stopReason,'stop');assert.equal(f.sent(),2)});
await test('pausing a provider blocks image and classifier dispatch without extra requests',async()=>{const f=fixture();f.pause();assert.equal((await f.images()).stopReason,'error');assert.equal((await f.classify()).stopReason,'error');assert.equal(f.sent(),0)});
await test('provider disabled while authentication awaits is checked again before request headers',async()=>{const f=fixture();f.beforeHeaders(async()=>{f.pause()});assert.match((await f.images()).errorMessage,/disabled/);assert.equal(f.sent(),0)});
await test('provider disabled inside caller header transform cannot pass the guard',async()=>{const f=fixture();const r=await f.classify({transformHeaders:async(h:any)=>{f.pause();return h}});assert.equal(r.stopReason,'error');assert.equal(f.sent(),0)});
await test('provider disabled inside payload transform cannot pass the guard',async()=>{const f=fixture();const r=await f.images({onPayload:async()=>{f.pause()}});assert.equal(r.stopReason,'error');assert.equal(f.sent(),0)});
await test('explicit cancellation returns native aborted results and sends no request',async()=>{const f=fixture();const c=new AbortController();c.abort();assert.equal((await f.images({signal:c.signal})).stopReason,'aborted');assert.equal((await f.classify({signal:c.signal})).stopReason,'aborted');assert.equal(f.sent(),0)});
await test('owning session revocation is checked after asynchronous authentication',async()=>{const f=fixture();let valid=true;f.beforeHeaders(async()=>{valid=false});const result=await withModelInvocationSettings(f.settings,()=>f.images(),()=>{if(!valid)throw Error('session-revoked')});assert.match(result.errorMessage,/session-revoked/);assert.equal(f.sent(),0)});
await test('admission installation is idempotent and preserves caller transforms',async()=>{const f=fixture();installModelInvocationAdmission(f.runtime,()=>f.settings);let headers=0,payload=0;assert.equal((await f.images({transformHeaders:async(h:any)=>{headers++;return h},onPayload:async(p:any)=>{payload++;return p}})).stopReason,'stop');assert.equal(f.sent(),1);assert.equal(headers,1);assert.equal(payload,1)});
mkdirSync('artifacts/pi100-upgrade',{recursive:true});writeFileSync('artifacts/pi100-upgrade/model-admission-results.json',JSON.stringify({at:new Date().toISOString(),paidProviderCalls:0,results},null,2));process.exitCode=results.every(r=>r.status==='passed')?0:1;

rmSync(root,{recursive:true,force:true});
