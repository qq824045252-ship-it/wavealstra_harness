import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { BotIncomingSummary } from '../src/main/agent/work/BotIncomingSummary';
import type { BotIncomingMessage } from '../src/shared/bot-collaboration';
const db=new DatabaseSync(':memory:');let now=0,calls=0;let fail=false,authority=true;
const items=new Map<string,BotIncomingMessage>();
const item=(id:string)=>({message:{messageId:id,collaborationId:'c',operationId:id,kind:'reply',text:'原文 '+id,senderBotId:'b'},collaboration:{sourceBotId:'a',sourceDisplayName:'A'},cursor:id}) as BotIncomingMessage;
for(const id of ['one','two'])items.set(id,item(id));
const opts={db:db as any,userId:'u',now:()=>now,authority:()=>authority,read:(_bot:string,id:string)=>items.get(id),generate:async(i:BotIncomingMessage)=>{calls++;if(fail)throw new Error('fake network');return '简洁 '+i.message.messageId;}};
const worker=new BotIncomingSummary(opts);
const offer=(ids:string[],retry:string[]=[])=>{const snapshots=ids.map(id=>structuredClone(items.get(id)!));worker.offer('b',snapshots,retry);return snapshots;};
async function settle(){for(let i=0;i<25;i++)await Promise.resolve();}
offer(['one','two']);offer(['one']);await settle();assert.equal(calls,2);assert.equal(offer(['one'])[0].summary?.text,'简洁 one');assert.equal(items.get('one')!.message.text,'原文 one');
items.get('one')!.message.text='更新的原文';offer(['one']);await settle();assert.equal(calls,3);
items.set('fail',item('fail'));fail=true;offer(['fail']);await settle();assert.equal(calls,4);offer(['fail']);await settle();assert.equal(calls,4);now=30000;offer(['fail']);await settle();now=100000;offer(['fail']);await settle();assert.equal(calls,6);now=999999;offer(['fail']);await settle();assert.equal(calls,6);fail=false;offer(['fail'],['fail']);await settle();assert.equal(calls,7);assert.equal(offer(['fail'])[0].summary?.status,'completed');
authority=false;assert.equal(offer(['one'])[0].summary?.text,'简洁 one','follower displays durable summary');items.set('no-authority',item('no-authority'));offer(['no-authority']);await settle();assert.equal(calls,7);authority=true;
items.set('existing',{...item('existing'),summary:{text:'已有整理',status:'completed',senderBotId:'a',senderDisplayName:'A'}});offer(['existing']);await settle();assert.equal(calls,7);worker.close();
items.set('interrupted',item('interrupted'));let release:(v:string)=>void=()=>{};
const interrupted=new BotIncomingSummary({...opts,generate:()=>new Promise<string>(r=>release=r)});interrupted.offer('b',[structuredClone(items.get('interrupted')!)]);interrupted.close();release('不能提交');await settle();now+=200000;
const restarted=new BotIncomingSummary(opts);restarted.offer('b',[structuredClone(items.get('interrupted')!)]);await settle();assert.equal(calls,8);
db.prepare("UPDATE bot_incoming_summaries SET status='running',attempts=3,retry_at=0 WHERE message_id='interrupted'").run();let expired=[structuredClone(items.get('interrupted')!)];restarted.offer('b',expired);assert.equal(expired[0].summary?.status,'failed');restarted.offer('b',expired,['interrupted']);await settle();assert.equal(calls,9);restarted.close();
const deleted=new BotIncomingSummary({...opts,read:()=>{throw new Error('Bot deleted');}});deleted.offer('b',[item('deleted')]);await settle();deleted.close();
console.log('PASS auto per-message summary, hash identity, cap/cooldown/manual retry, existing summary, authority, durable restart/third lease, deleted Bot, originals retained');

// A result generated for one user cannot satisfy another user's record.
const other=new BotIncomingSummary({...opts,userId:'other-user'});other.offer('b',[structuredClone(items.get('one')!)]);await settle();assert.equal(calls,10);other.close();
// Source deletion while a fake completion is in flight cannot publish stale output.
let finish:(v:string)=>void=()=>{};items.set('inflight',item('inflight'));
const fence=new BotIncomingSummary({...opts,generate:()=>new Promise<string>(r=>finish=r)});fence.offer('b',[structuredClone(items.get('inflight')!)]);items.delete('inflight');finish('stale');await settle();assert.notEqual(db.prepare("SELECT status FROM bot_incoming_summaries WHERE message_id='inflight'").get()!.status,'completed');fence.close();
console.log('PASS user isolation and deletion fence during generation');
