import assert from 'node:assert/strict';
import { BotConversationService } from '../src/main/agent/work/BotConversationService';
import { BotCollaborationDelivery } from '../src/main/agent/work/BotCollaborationDelivery';

const relation = {collaborationId:'relation',sourceBotId:'source',targetBotId:'deleted',sourceDisplayName:'Source',targetDisplayName:'Deleted',sourceBotExists:true,targetBotExists:false};
let accepted=0, linked=0, prior:any;
const receipt={botId:'source',requestId:'request',conversationId:'conversation',userMessageId:'user-message',assistantMessageId:'assistant-message',replayed:true};
const host:any={
 options:{userId:'u',directory:'unused',works:{transaction:(fn:()=>unknown)=>fn()},bots:{getBot:()=>({status:'disabled'})}},
 messages:{receipt:()=>prior,accept:()=>{accepted++;return receipt}},
 collaborations:{repo:{scoped:()=>relation},bindSend:()=>{linked++}},
 assertBot:()=>{},assertTeam:()=>{},scheduleReceipt:()=>{},
};
const request={botId:'source',requestId:'request',conversationId:'conversation',selectedCollaborationId:'relation',text:'follow up'};
assert.throws(()=> (BotConversationService.prototype as any).admit.call(host,request),/Bot 已删除/);
assert.equal(accepted,0,'deleted target is rejected before receipt/message/attachment admission');
assert.equal(linked,0);
prior={request_id:'request'};
assert.deepEqual((BotConversationService.prototype as any).admit.call(host,request),receipt,'existing accepted request replays after deletion');
assert.equal(accepted,1);
assert.equal(linked,1);
let prepared=0,appended=0;
const delivery=new BotCollaborationDelivery({userId:'u',works:{transaction:(fn:()=>unknown)=>fn()}} as any,
 {peers:{get:()=>undefined,prepare:()=>prepared++}} as any,
 {get:()=>relation,appendMessage:()=>appended++} as any, {} as any,()=>{});
await assert.rejects(delivery.send(relation as any,{bot_id:'source',conversation_id:'conversation',request_id:'request',user_message_id:'user-message',assistant_message_id:'assistant-message'} as any,'new-operation','new request'),/Bot 已删除/);
assert.equal(prepared,0,'new outbox must not be created for deleted target');
assert.equal(appended,0,'no new collaboration history request on rejected dispatch');
console.log('PASS deleted collaboration: admission rejects new request, accepted receipt replay, delivery has no outbox/history side effects');
