// Exercise exact production service methods with database, adapter and encryption
// ports stubbed. No constructor/network, user database, esbuild or Codex involved.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import vm from 'node:vm';
const text=readFileSync(new URL('../src/main/gateway/GatewayService.ts',import.meta.url),'utf8');
const names=['assertBusinessRegistrationEmpty','acceptBusinessRegistration','startBusinessRegistration','cancelBusinessRegistration','registration','beginChannelOperation','ownsChannelOperation'];
const methods=names.map(name=>{const match=new RegExp('^  (?:private |async )*(?:async )?'+name+'\\(','m').exec(text);assert(match,name);const end=text.indexOf('\n  }',match.index);assert(end>=0,name);return text.slice(match.index,end+4);});
const output=resolve('out/tests/business-registration-service');mkdirSync(output,{recursive:true});
writeFileSync(resolve(output,'extracted.ts'),'class Service {'+methods.join('\n')+'}\nglobalThis.Service=Service;');
writeFileSync(resolve(output,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'commonjs',noCheck:true,skipLibCheck:true},files:['extracted.ts']}));
const compiled=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',resolve(output,'tsconfig.json')],{stdio:'inherit'});assert.equal(compiled.status,0);
const code=readFileSync(resolve(output,'extracted.js'),'utf8');
const context={assertGatewayProviderStorage(){},validateGatewayProviderConfig:(_,x)=>x,sealGatewayProviderConfig:()=>({encryptedSecrets:'sealed'}),toStrArray:v=>v,Map,Symbol,Promise};vm.runInNewContext(code,context);const Service=context.Service;
function fixture(rows=[],connected=false){let connects=0,disconnects=0,saves=0,activates=0;let release;const adapter={id:'feishu-default',type:'feishu',name:'Feishu',isConnected:()=>connected,statusText:()=>'',connect:async()=>{connects++;if(release===null)await new Promise(r=>release=r);connected=true;},disconnect:async()=>{disconnects++;connected=false;},activate:()=>activates++};const s=new Service();Object.assign(s,{feishu:adapter,dingtalk:adapter,db:{listGatewayChannels:()=>rows,upsertGatewayChannel:x=>{rows.push(x);saves++;},connection:{transaction:f=>f}},lifecycleEpoch:0,stopping:false,channelOperations:new Map(),bindingGenerations:new Map(),channelPolicies:new Map(),businessQrPending:new Map(),businessQrEpoch:new Map(),businessQr:new Map([['feishu',{getState:()=>({state:'idle'}),cancel(){},start:async()=>({state:'waiting'})}]]),secrets:{remember(){}},platforms:{resume(){}},emitEvent(){}});return {s,adapter,rows,counts:()=>({connects,disconnects,saves,activates}),block:()=>{release=null;},release:()=>release()};}
for(const f of [fixture([{id:'feishu-default',configJson:'{"encryptedSecrets":"old"}',connected:false}]),fixture([],true)]){
 await assert.rejects(f.s.startBusinessRegistration('feishu',true),/已有配置/);
 assert.throws(()=>f.s.acceptBusinessRegistration('feishu',{allowUsers:['owner']},()=>{},new AbortController().signal),/已有配置/);
 assert.deepEqual(f.counts(),{connects:0,disconnects:0,saves:0,activates:0});
}
const fresh=fixture();await fresh.s.acceptBusinessRegistration('feishu',{allowUsers:['owner']},()=>{},new AbortController().signal);assert.equal(fresh.counts().saves,1);assert.equal(fresh.rows[0].configJson,'{"encryptedSecrets":"sealed"}');
const changed=fixture();changed.block();const pending=changed.s.acceptBusinessRegistration('feishu',{allowUsers:['owner']},()=>{},new AbortController().signal);changed.rows.push({id:'feishu-default',configJson:'{"encryptedSecrets":"other"}',connected:false});changed.release();await assert.rejects(pending);assert.equal(changed.counts().saves,0);assert.equal(changed.rows[0].configJson,'{"encryptedSecrets":"other"}');
const cancelled=fixture();cancelled.block();const controller=new AbortController();const stopped=cancelled.s.acceptBusinessRegistration('feishu',{allowUsers:['owner']},()=>{if(controller.signal.aborted)throw Error('cancelled');},controller.signal);controller.abort();cancelled.release();await assert.rejects(stopped);assert.equal(cancelled.counts().saves,0);
console.log('PASS production GatewayService QR methods: preserve configured/live channels without disconnect, empty-channel encrypted commit, concurrent config and cancelled late commit rejected');



const superseded=fixture();superseded.block();const old=superseded.s.acceptBusinessRegistration('feishu',{allowUsers:['owner']},()=>{},new AbortController().signal);superseded.s.beginChannelOperation('feishu-default');superseded.release();await assert.rejects(old);assert.equal(superseded.counts().disconnects,0);assert.equal(superseded.counts().saves,0);console.log('PASS old failed operation cannot disconnect new owner');
