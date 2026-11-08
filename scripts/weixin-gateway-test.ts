import assert from 'node:assert/strict';
import { WeixinIlinkAdapter } from '../src/main/gateway/WeixinIlinkAdapter';
import { WeixinIlinkClient, ilinkBase } from '../src/main/gateway/WeixinIlinkClient';
import { WeixinQrLogin } from '../src/main/gateway/WeixinQrLogin';
const json = (value: unknown) => new Response(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const until = async (condition: () => boolean) => { for(let i=0;i<100&&!condition();i++) await tick(); assert.ok(condition()); };
const config = { accountId:'bot', userId:'owner', baseUrl:'https://ilinkai.weixin.qq.com', botToken:'TOP-SECRET', allowUsers:['owner'] };
for(const url of ['http://ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com.evil.org','https://evil.weixin.qq.com','https://ilinkai.weixin.qq.com/path','https://x@ilinkai.weixin.qq.com']) assert.throws(()=>ilinkBase(url));
let polls=0; const requests: any[]=[]; let received=0; let oldReply: ((s:string)=>Promise<void>)|undefined;
const fetcher: typeof fetch = async (url, options) => {
  const body=JSON.parse(String(options?.body || '{}')); requests.push({ url:String(url),body });
  if(String(url).endsWith('getupdates')) {
    polls++;
    if(polls===1) return json({ret:0,get_updates_buf:'cursor',msgs:[
      {message_id:'bad',from_user_id:'stranger',message_type:1,item_list:[{type:1,text_item:{text:'unauthorized'}}]},
      ...[1,1].map(()=>({message_id:'one',from_user_id:'owner',to_user_id:'bot',message_type:1,message_state:2,context_token:'PRIVATE-CONTEXT',item_list:[{type:1,text_item:{text:'hello'}}]})),
    ]});
    return new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }
  return json({ret:0});
};
const adapter=new WeixinIlinkAdapter('weixin-default','微信',{fetch:fetcher,deferInboundUntilActivated:true});
adapter.setInboundHandler(async msg=>{received++;oldReply=msg.reply;assert.equal(msg.text,'hello');assert.ok(!JSON.stringify({...msg,reply:undefined}).includes('PRIVATE-CONTEXT'));await msg.reply('reply');});
await adapter.connect(config); assert.equal(polls,0); adapter.activate(); await until(()=>received===1 && requests.some(r=>r.url.endsWith('sendmessage')));
const send=requests.find(r=>r.url.endsWith('sendmessage')); assert.equal(send.body.msg.context_token,'PRIVATE-CONTEXT');assert.equal(send.body.msg.to_user_id,'owner');
await adapter.disconnect(); await assert.rejects(()=>oldReply!('late')); assert.equal(received,1);
await assert.rejects(()=>adapter.connect({...config,allowUsers:[]}));
let sends=0;
const lost=new WeixinIlinkClient(async()=>{sends++;throw new Error('TOP-SECRET');});
await assert.rejects(()=>lost.request(config.baseUrl,'sendmessage',config.botToken,{},new AbortController().signal),e=>e instanceof Error&&!e.message.includes('TOP-SECRET'));assert.equal(sends,1);
let calls=0;let save=0;
const qr=new WeixinQrLogin({fetch:async(url,opts)=>{calls++;if(String(url).includes('get_bot_qrcode'))return json({qrcode:'code',qrcode_img_content:'https://weixin.qq.com/qr'});
return new Promise<Response>((_resolve,reject)=>opts?.signal?.addEventListener('abort',()=>reject(new Error('cancel')),{once:true}));},onAuthorized:async()=>{save++;}});
await assert.rejects(()=>qr.start(false));assert.equal(calls,0);
const first=await qr.start(true);assert.ok(first.sessionId);const second=await qr.start(true);assert.notEqual(first.sessionId,second.sessionId);
qr.cancel(first.sessionId);assert.equal(qr.getState().status,'waiting');qr.cancel(second.sessionId);await tick();assert.equal(qr.getState().status,'cancelled');assert.equal(qr.getState().sessionId,second.sessionId);assert.equal(save,0);
const expired = new WeixinIlinkAdapter('weixin-default','微信',{fetch:async()=>json({ret:-14})});
await expired.connect(config); await until(()=>!expired.isConnected()); assert.match(expired.statusText(),/重新扫码/); await expired.disconnect();
let untrustedCalls=0;
const untrustedQr = new WeixinQrLogin({fetch:async(url)=>{untrustedCalls++;return String(url).includes('get_bot_qrcode')?json({qrcode:'code',qrcode_img_content:'payload'}):json({status:'confirmed',ilink_bot_id:'bot',ilink_user_id:'owner',bot_token:'TOP-SECRET',baseurl:'https://evil.org'});},onAuthorized:async()=>{throw new Error('must not save');}});
await untrustedQr.start(true);await until(()=>untrustedQr.getState().status==='error');assert.equal(untrustedCalls,2);assert.ok(!JSON.stringify(untrustedQr.getState()).includes('TOP-SECRET'));untrustedQr.cancel();
// Long replies retain Unicode code points, await each receipt, and stop on uncertain delivery.
const longText = 'a'.repeat(3999) + '😀' + '文'.repeat(5000);
for (const failure of ['none', 'unknown', 'transport', 'disconnect'] as const) {
  const parts: string[] = []; let done = false; let failed = false; let release!: () => void; let resolveFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { resolveFirst = resolve; });
  const firstReceipt = new Promise<void>(resolve => { release = resolve; });
  const a = new WeixinIlinkAdapter('weixin-default','微信',{fetch:async(url,opts)=>{
    if (String(url).endsWith('getupdates')) return json({ret:0,msgs:[{message_id:'long',from_user_id:'owner',message_type:1,context_token:'ctx',item_list:[{type:1,text_item:{text:'hello'}}]}]});
    const part = JSON.parse(String(opts?.body)).msg.item_list[0].text_item.text;
    parts.push(part);
    if(parts.length===1){ resolveFirst(); await firstReceipt; }
    if(parts.length===2 && failure==='unknown')return json({});
    if(parts.length===2 && failure==='transport')throw new Error('lost');
    return json({ret:0});
  }});
  a.setInboundHandler(async msg=>{ try { await msg.reply(longText); } catch { failed=true; } finally { done=true; } });
  await a.connect(config); await firstStarted; await tick(); assert.equal(parts.length,1,'must await first receipt');
  if(failure==='disconnect')await a.disconnect();
  release(); await until(()=>done); await a.disconnect();
  assert.equal(failed,failure!=='none');
  assert.equal(parts.length,failure==='none'?3:failure==='disconnect'?1:2);
  for(const part of parts){assert.ok(part.length<=4000);assert.ok(!/[\uD800-\uDFFF]/u.test(part));}
  if(failure==='none')assert.equal(parts.join(''),longText);
}
for(const terminal of ['expired','error','authorized'] as const){
  const q = new WeixinQrLogin({fetch:async url=>String(url).includes('get_bot_qrcode')?json({qrcode:'code',qrcode_img_content:'payload'}):
    terminal==='error'?json({ret:-1}):terminal==='expired'?json({status:'expired'}):json({status:'confirmed',ilink_bot_id:'bot',ilink_user_id:'owner',bot_token:'secret',baseurl:config.baseUrl}),onAuthorized:async()=>{}});
  const started = await q.start(true); assert.ok(started.sessionId);
  await until(()=>q.getState().status===terminal);
  assert.equal(q.getState().sessionId,started.sessionId);
  assert.equal(q.getState().qrUrl,undefined);
  q.cancel(started.sessionId);assert.equal(q.getState().sessionId,started.sessionId);
}
const failedStart = new WeixinQrLogin({fetch:async()=>{throw new Error('network');},onAuthorized:async()=>{}});
const failedState=await failedStart.start(true);assert.equal(failedState.status,'error');assert.ok(failedState.sessionId);
failedStart.cancel(failedState.sessionId);assert.equal(failedStart.getState().sessionId,failedState.sessionId);
console.log('PASS Weixin: trusted hosts, owner gate, deferred activation, dedup, context secrecy, cancellation, no blind retry, QR authorization/session race');
