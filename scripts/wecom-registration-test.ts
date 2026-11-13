import assert from "node:assert/strict";
import {createWecomRegistrationDriver} from "../src/main/gateway/BusinessBotRegistrationDrivers";
import {BusinessBotRegistration} from "../src/main/gateway/BusinessBotRegistration";
const signal=new AbortController().signal;
function fixture(responses:any[]){const calls:Array<{url:string;options:RequestInit}>=[];return {calls,fetcher:(async(url,options)=>{calls.push({url:String(url),options:options!});return Response.json(responses.shift());}) as typeof fetch};}
const f=fixture([{data:{scode:"private & code",auth_url:"https://work.weixin.qq.com/ai/authorize?ticket=public-scan"}},{data:{status:"waiting"}},{data:{status:"success",bot_info:{botid:"bot-1",secret:"private-secret"}}}]);
const driver=createWecomRegistrationDriver(f.fetcher);const ticket=await driver.begin(signal);
assert.equal(f.calls[0].url,"https://work.weixin.qq.com/ai/qc/generate?source=hermes");assert.equal(ticket.expiresInSeconds,300);
assert.deepEqual(await driver.poll(ticket,signal),{state:"pending"});const authorized=await driver.poll(ticket,signal);assert.equal(authorized.state,"authorized");
assert.equal(f.calls[1].url,"https://work.weixin.qq.com/ai/qc/query_result?scode=private%20%26%20code");assert(f.calls.every(c=>c.options.redirect==='error'&&c.options.method==='GET'));
const bad=fixture([{data:{scode:'a',auth_url:'https://work.weixin.qq.com.attacker.invalid/scan'}}]);await assert.rejects(createWecomRegistrationDriver(bad.fetcher).begin(signal));
const missing=fixture([{data:{status:'success',bot_info:{botid:'b'}}}]);await assert.rejects(createWecomRegistrationDriver(missing.fetcher).poll(ticket,signal));
let config:Record<string,unknown>|undefined;
const enrollment=new BusinessBotRegistration({provider:'wecom',driver:{begin:async()=>ticket,poll:async()=>authorized},delay:async()=>{},onAuthorized:async value=>{config=value;}});
await enrollment.start(true);await new Promise(r=>setImmediate(r));const state=enrollment.getState();assert.equal(state.state,'configuration');assert.deepEqual(state.missingFields,['allowUsers']);assert(!JSON.stringify(state).includes('private-secret'));assert.equal(config,undefined);
await enrollment.finish(state.sessionId!,{allowUsers:[]});assert.equal(config,undefined);
await enrollment.finish(state.sessionId!,{allowUsers:['member-1']});assert.deepEqual(config,{botId:'bot-1',secret:'private-secret',mode:'smart',allowUsers:['member-1']});assert.equal(enrollment.getState().state,'connected');
console.log('PASS WeCom upstream protocol, official-host checks, encoded ticket, incomplete success rejected, credentials main-only and explicit allowlist before Smart Robot connection');
for (const response of [{errcode:400,data:{status:'waiting'}},{},{data:{}},{data:{status:'failed'}},{data:{status:'denied'}},{data:{status:'cancelled'}}]) { const badResponse=fixture([response]); await assert.rejects(createWecomRegistrationDriver(badResponse.fetcher).poll(ticket,signal)); }
for (const status of ['expired','timeout']) { const expired=fixture([{data:{status}}]); assert.deepEqual(await createWecomRegistrationDriver(expired.fetcher).poll(ticket,signal),{state:'expired'}); }
const unknown=fixture([{data:{status:'new-provider-state'}},{data:{status:'new-provider-state'}},{data:{status:'new-provider-state'}}]);const unknownDriver=createWecomRegistrationDriver(unknown.fetcher),unknownTicket={...ticket,token:{scode:'s'}};assert.deepEqual(await unknownDriver.poll(unknownTicket,signal),{state:'pending'});assert.deepEqual(await unknownDriver.poll(unknownTicket,signal),{state:'pending'});await assert.rejects(unknownDriver.poll(unknownTicket,signal));
console.log('PASS explicit errors/malformed response rejected, expiry surfaced, unknown status bounded without authorization');

const failedBegin=fixture([{errcode:400,data:{scode:'s',auth_url:'https://work.weixin.qq.com/scan'}}]);await assert.rejects(createWecomRegistrationDriver(failedBegin.fetcher).begin(signal));
