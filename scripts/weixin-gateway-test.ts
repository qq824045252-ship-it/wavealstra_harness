import assert from 'node:assert/strict';
import { GatewayReplyNotSentError } from '../src/main/gateway/GatewayReply';
import type { GatewayInboundMessage } from '../src/main/gateway/channels';
import { WeixinIlinkAdapter } from '../src/main/gateway/WeixinIlinkAdapter';
import { WeixinIlinkClient, ilinkBase } from '../src/main/gateway/WeixinIlinkClient';
import { WeixinQrLogin } from '../src/main/gateway/WeixinQrLogin';
const json = (value: unknown) => new Response(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const until = async (condition: () => boolean) => { for(let i=0;i<300&&!condition();i++) await tick(); assert.ok(condition()); };
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
  const parts: string[] = []; let done = false; let failed = false; let failureError: unknown; let release!: () => void; let resolveFirst!: () => void;
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
  a.setInboundHandler(async msg=>{ try { await msg.reply(longText); } catch (error) { failed=true; failureError=error; } finally { done=true; } });
  await a.connect(config); await firstStarted; await tick(); assert.equal(parts.length,1,'must await first receipt');
  if(failure==='disconnect')await a.disconnect();
  release(); await until(()=>done); await a.disconnect();
  assert.equal(failed,failure!=='none');
  if (failed) assert.equal(failureError instanceof GatewayReplyNotSentError, false, 'after a confirmed chunk, later failures must remain uncertain to prevent whole-text replay');
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
// Context capability lifetime is bounded independently from message deduplication.
{
  let now = 1000; let delivered = 0; let posts = 0; let polls = 0;
  let nextPoll!: (response: Response) => void;
  const messages = new Map<string, { reply: (text: string) => Promise<void>; replyRoute?: any; chatId: string; messageId?: string; sender?: { id: string } }>();
  const peers = Array.from({ length: 1025 }, (_, i) => `peer-${i}`);
  const message = (peer: string, id = peer) => ({ message_id: id, from_user_id: peer, to_user_id: 'bot', message_type: 1,
    context_token: `SECRET-${peer}`, item_list: [{ type: 1, text_item: { text: 'context' } }] });
  const bounded = new WeixinIlinkAdapter('bounded', '微信', { now: () => now, fetch: async (url, init) => {
    if (String(url).endsWith('getupdates')) {
      if (!polls++) return json({ ret: 0, msgs: peers.map(peer => message(peer)) });
      return new Promise<Response>((resolve, reject) => { nextPoll = resolve;
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    }
    posts++; return json({ ret: 0 });
  } });
  bounded.setInboundHandler(async msg => { delivered++; messages.set(msg.chatId, msg);
    assert.ok(!JSON.stringify({ ...msg, reply: undefined }).includes('SECRET-')); });
  await bounded.connect({ ...config, allowUsers: peers });
  await until(() => delivered === peers.length);
  await assert.rejects(() => messages.get(peers[0])!.reply('evicted'), /令牌缺失/);
  assert.equal(posts, 0, 'capacity eviction must prevent use of the old capability before I/O');
  await messages.get(peers.at(-1)!)!.reply('present'); assert.equal(posts, 1);
  now += 24 * 60 * 60_000 + 1;
  await assert.rejects(() => messages.get(peers.at(-1)!)!.reply('expired'), /保留期/); assert.equal(posts, 1);
  await until(() => !!nextPoll);
  nextPoll(json({ ret: 0, msgs: [message(peers[0], 'fresh')] }));
  await until(() => delivered === peers.length + 1);
  const current = messages.get(peers[0])!;
  const restored = bounded.restoreGatewayReply({ deliveryId: 'delivery', chatId: current.chatId,
    messageId: current.messageId!, sender: current.sender, route: current.replyRoute });
  assert.ok(restored); await restored!('refreshed'); assert.equal(posts, 2);
  await bounded.disconnect();
  await assert.rejects(() => restored!('stale connection'), /连接已更换/); assert.equal(posts, 2);
}
// Persist an entire poll batch before waiting for native turns, and never move
// its cursor past a rejected inbox admission.
{
  let finish!: () => void; const nativeTurn = new Promise<void>(resolve => { finish = resolve; });
  const cursors: string[] = [], admitted: string[] = []; let firstRejected = false;
  const durable = new WeixinIlinkAdapter('durable-weixin','微信',{fetch:async (url,options) => {
    assert.ok(String(url).endsWith('getupdates'));
    const cursor = JSON.parse(String(options?.body)).get_updates_buf; cursors.push(cursor);
    if (cursors.length <= 2) return json({ret:0,get_updates_buf:'committed-batch',msgs:['one','two'].map(message_id=>({message_id,from_user_id:'owner',to_user_id:'bot',message_type:1,item_list:[{type:1,text_item:{text:message_id}}]}))});
    return new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }});
  durable.setInboundHandler(message => {
    admitted.push(message.messageId!);
    if (!firstRejected) { firstRejected = true; const failed = Promise.reject(new Error('disk unavailable')); return Object.assign(failed,{accepted:failed}); }
    return Object.assign(message.messageId === 'one' ? nativeTurn : Promise.resolve(),{accepted:Promise.resolve()});
  });
  await durable.connect(config); await until(() => cursors.length === 3);
  assert.deepEqual(cursors,['','','committed-batch']); assert.deepEqual(admitted,['one','one','two']);
  finish(); await durable.disconnect();
}
// Opaque capabilities survive a restart without exposing tokens in journal metadata.
{
  const vault = new Map<string, string>();
  const codec = { seal(value: string) { const key = `opaque-${vault.size}`; vault.set(key, value); return key; },
    open(key: string) { const value = vault.get(key); if (!value) throw new Error('missing keyring'); return value; } };
  let first = true, clock = Date.now(), sends = 0; let message!: GatewayInboundMessage;
  const encrypted = new WeixinIlinkAdapter('sealed-weixin', '微信', { replySecrets: codec, now: () => clock,
    fetch: async (url, options) => {
      if (String(url).endsWith('sendmessage')) { sends++; assert.equal(JSON.parse(String(options?.body)).msg.context_token, 'PRIVATE-RECOVERY-TOKEN'); return json({ret:0}); }
      if (first) { first = false; return json({ret:0, get_updates_buf:'saved', msgs:[{message_id:'sealed-message',from_user_id:'owner',to_user_id:'bot',message_type:1,message_state:2,context_token:'PRIVATE-RECOVERY-TOKEN',item_list:[{type:1,text_item:{text:'hello'}}]}]}); }
      return new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    } });
  encrypted.setInboundHandler(async value => { message = value; });
  await encrypted.connect(config); await until(() => !!message);
  const route = message.replyRoute!; if (route.kind !== 'weixin') throw new Error('missing route');
  assert.ok(route.encryptedCapability); assert.doesNotMatch(JSON.stringify(route), /PRIVATE-RECOVERY-TOKEN/);
  const envelope = JSON.parse(codec.open(route.encryptedCapability!));
  const input = { deliveryId:'weixin-journal-reply',chatId:message.chatId,messageId:message.messageId!,sender:message.sender,route };
  await encrypted.disconnect(); await encrypted.connect(config);
  const reply = encrypted.restoreGatewayReply(input); assert.ok(reply); await reply('after restart'); assert.equal(sends,1);
  for (const mutation of [{accountKey:'other'},{peer:'other'},{messageId:'other'},{expiresAt:clock-1},{contextToken:''}]) {
    const encryptedCapability = codec.seal(JSON.stringify({...envelope,...mutation}));
    await assert.rejects(encrypted.restoreGatewayReply({...input,route:{...route,encryptedCapability}})!('must not send'), GatewayReplyNotSentError);
  }
  await assert.rejects(encrypted.restoreGatewayReply({...input,route:{...route,encryptedCapability:'lost-key'}})!('must not send'), GatewayReplyNotSentError);
  assert.equal(encrypted.restoreGatewayReply({...input,chatId:'other'}),undefined); assert.equal(sends,1);
  clock += 24 * 60 * 60_000 + 1;
  await assert.rejects(reply('expired after restoration'), GatewayReplyNotSentError); assert.equal(sends,1);
  await encrypted.disconnect();
}
console.log('PASS Weixin: trusted hosts, owner gate, deferred activation, dedup, context secrecy, cancellation, no blind retry, QR authorization/session race');
