/** Synthetic renderer-only measurements. Host polling is disabled, not product polling. */
import {useAppStore} from '../src/renderer/src/store/appStore';
import type {BotMessageDto} from '../src/shared/bot-conversation';
const metrics: Array<{actual: number}> = [];
const counters = window as unknown as {messageRenderCount: number};
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
let started = 0, loaded = 0;
function begin() {metrics.length=0;counters.messageRenderCount=0;started=performance.now();}
function result(kind: string) {
  const count=document.querySelectorAll('[data-message-id]').length;
  if(count!==loaded)throw Error(`history lost during ${kind}: ${count}/${loaded}`);
  return {kind,loaded,totalMs:performance.now()-started,actualMs:metrics.reduce((sum,x)=>sum+x.actual,0),
    commits:metrics.length,messageRenders:counters.messageRenderCount,domMessages:count,domNodes:document.querySelectorAll('*').length};
}
export function recordHistoryRender(_id: string,_phase: string,actual: number) {metrics.push({actual});}
export function installHistoryRenderFixture() {
  Object.assign(window,{historyPerf:{
    async seed(n: number) {
      begin();loaded=n;
      const messages: BotMessageDto[]=Array.from({length:n},(_,i)=>({botId:'bot',conversationId:'perf-'+n,requestId:'req-'+Math.floor(i/2),
        messageId:'message-'+i,ordinal:i+1,role:i%2?'assistant':'user',status:'completed',messageRevision:1,workIds:[],
        createdAt:1700000000000+i,updatedAt:1700000000000+i,
        text:i%2?(`## Answer ${i}\n\nA paragraph with **bold**, _emphasis_, and inline code. 中文内容用于验证真实排版。\n\n- First item\n- Second item\n\n`).repeat(4):'Question '+i}));
      useAppStore.setState({botHistories:{bot:{botId:'bot',conversationId:'perf-'+n,revision:1,archived:false,messages}},
        botDraft:'',botHistoryPages:{},refreshBotHistory:async()=>{}});
      await paint();return result('seed');
    },
    beginTyping() {
      const textarea=document.querySelector<HTMLTextAreaElement>('textarea#bot-draft')!;
      textarea.focus();textarea.setSelectionRange(textarea.value.length,textarea.value.length);
      const expected=textarea.value+'x';begin();return expected;
    },
    async finishTyping(expected: string) {
      while(useAppStore.getState().botDraft!==expected) {
        if(performance.now()-started>10000)throw Error('native typing did not reach the draft');
        await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      }
      await paint();return result('native-type');
    },
    async stream() {
      begin();const h=useAppStore.getState().botHistories.bot,m=h.messages.at(-1)!;
      useAppStore.setState({botHistories:{bot:{...h,revision:h.revision+1,messages:h.messages.map(x=>x===m?
        {...m,status:'running',messageRevision:(m.messageRevision??0)+1,text:m.text+' more'}:x)}}});
      await paint();return result('stream');
    },
    async rename() {
      useAppStore.setState(state=>({botIdentities:state.botIdentities.map(bot=>({...bot,displayName:'Renamed fixture Bot'}))}));
      await paint();
      if([...document.querySelectorAll('.bot-message.assistant')].some(node=>node.getAttribute('aria-label')!=='Renamed fixture Bot的消息'))throw Error('stale Bot name');
    },
    async subscriptionsAndLocalState() {
      const original=useAppStore.getState().botHistories.bot.messages;
      useAppStore.setState({tasks:[{id:'bot-acp-message-1',title:'External fixture task',status:'completed',cwd:'/synthetic'}] as never});
      await paint();
      const target=()=>document.querySelector<HTMLElement>('[data-message-id="message-1"]')!;
      if(!target().textContent?.includes('打开外部 Agent 任务') || useAppStore.getState().botHistories.bot.messages!==original)throw Error('child subscription did not update independently');
      useAppStore.setState({tasks:[]});await paint();
      if(target().textContent?.includes('打开外部 Agent 任务'))throw Error('removed task link stayed stale');
      const h=useAppStore.getState().botHistories.bot;
      useAppStore.setState({botHistories:{bot:{...h,messages:h.messages.map(m=>m.messageId==='message-1'?{...m,
        text:'![fixture image](synthetic.svg)',reportImages:{taskId:'image-task',sources:{'synthetic.svg':'perf-image'},artifacts:[{
          id:'perf-image',taskId:'image-task',kind:'svg',version:1,capabilities:{},createdAt:1,updatedAt:1,
          source:{type:'managed-content',storagePath:'synthetic.svg',rootDir:'/synthetic'},title:'synthetic.svg'}]},
        botCalls:[{callId:'call-fixture',sourceBotId:'bot',targetBotId:'other',sourceDisplayName:'Source',targetDisplayName:'Target',
          status:'completed',requestText:'Question',replyText:'Answer'}] as never}:m)}}});
      await paint();const stable=useAppStore.getState().botHistories.bot.messages;
      useAppStore.setState({artifactRenderCache:{'perf-image':{artifactId:'perf-image',artifactVersion:1,
        content:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>'} as never}});
      await paint();await paint();
      const img=target().querySelector<HTMLImageElement>('img.chat-inline-image');
      if(!img?.src.startsWith('blob:') || useAppStore.getState().botHistories.bot.messages!==stable)throw Error('image payload subscription did not update independently');
      const fold=target().querySelector<HTMLDetailsElement>('.bot-call-thread')!;fold.open=true;
      img.click();await paint();
      if(!document.querySelector<HTMLDialogElement>('dialog[aria-label="报告原图"]')?.open)throw Error('image local preview did not open');
      useAppStore.getState().setBotDraft('draft while local state is open');await paint();
      if(!fold.open || !document.querySelector<HTMLDialogElement>('dialog[aria-label="报告原图"]')?.open)throw Error('typing reset fold or preview state');
      document.querySelector<HTMLButtonElement>('dialog[aria-label="报告原图"] button')!.click();await paint();
      if(document.querySelector('dialog[aria-label="报告原图"]'))throw Error('image local preview did not close');
    },
    transcript: () => document.querySelector('.bot-message-list')!.innerHTML,
  }});
}
