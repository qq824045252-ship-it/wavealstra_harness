import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {act} from 'react';
import {BotReplyReference} from '../src/renderer/src/components/pages/BotReplyReference';
import type {BotMessageDto} from '../src/shared/bot-conversation';
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const document=window.document;
Object.assign(globalThis,{window,document,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
async function main(){
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const draw=(text:string,attachments:any[]=[],messageId='a')=>act(async()=>{root.render(<BotReplyReference message={{messageId,text,attachments} as BotMessageDto}/>);});
 const long='<script>alert(1)</script> '+ '原始问题'.repeat(500);
 await draw(long,[{name:'report.csv'}]);
 const details=document.querySelector('details')!;
 assert(!details.hasAttribute('open'),'reference begins collapsed');
 assert.equal(document.querySelector('.bot-reply-reference-original > div')?.textContent,long,'full source retained without truncation');
 assert.equal(document.querySelectorAll('script').length,0,'reference text is escaped, not HTML');
 assert(document.querySelector('.bot-reply-reference-attachments')?.textContent?.includes('report.csv'));
 assert.equal(details.getAttribute('data-source-message-id'),'a');
 assert.equal(document.querySelector('.bot-reply-reference-original')?.getAttribute('tabindex'),'0');
 await draw('',[{name:'only.txt'}],'b');
 assert.equal(document.querySelector('.bot-reply-reference-preview')?.textContent,'only.txt');
 assert.equal(document.querySelector('details')?.getAttribute('data-source-message-id'),'b');
 assert(!document.body.textContent?.includes(long));
 await draw('');assert(document.querySelector('.bot-reply-reference-original')?.textContent?.includes('原消息无文本'));
 await act(()=>root.unmount());
 console.log('reply-reference DOM PASS: collapsed structure, exact long source, attachments-only, empty fallback, escaping and source switch; native details keyboard/layout require browser');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
