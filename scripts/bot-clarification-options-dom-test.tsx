import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import React,{act} from 'react';
import {ConversationInteractionCard} from '../src/renderer/src/components/chat/ConversationRuntimeCards';
import type {ConversationInteractionDto} from '../src/shared/conversation-interaction';
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
async function main(){
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const card:ConversationInteractionDto={id:'goal',taskId:'',executionId:'r',assistantMessageId:'m',kind:'single_select',title:'文件格式？',options:[{id:'html',label:'HTML'},{id:'pdf',label:'PDF'}],allowCustom:true,status:'pending',version:1,createdAt:1};
 let dismiss=0;const answers:unknown[]=[];
 await act(async()=>root.render(<ConversationInteractionCard interaction={card} onRespond={async answer=>{answers.push(answer);return {ok:true};}} onDismiss={()=>dismiss++}/>));
 assert.equal(document.querySelectorAll('input[type="radio"]').length,2);
 assert(document.querySelector('input.conversation-interaction-input'));
 const buttons=[...document.querySelectorAll('button')];assert(buttons.find(b=>b.textContent==='提交回答')?.disabled);
 await act(async()=>buttons.find(b=>b.textContent==='暂不回答')!.click());assert.equal(dismiss,1);assert.deepEqual(answers,[]);
 await act(async()=>root.render(<ConversationInteractionCard interaction={{...card,status:'resolved',answer:'html'}}/>));
 assert(document.body.textContent?.includes('已回答'));assert.equal(document.querySelectorAll('input').length,0);
 await act(async()=>root.render(<ConversationInteractionCard interaction={{...card,status:'resolved'}}/>));
 assert(!document.body.textContent?.includes('已回答：'),'no empty answer label');
 await act(async()=>root.render(<ConversationInteractionCard interaction={{...card,status:'resolved'}} answerDisplayText="html"/>));
 assert(document.body.textContent?.includes('已回答：html'),'manual answer matching option ID remains literal in history');
 await act(async()=>root.unmount());console.log('PASS clarification options DOM: options, manual input, empty guard, dismiss, resolved history');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
