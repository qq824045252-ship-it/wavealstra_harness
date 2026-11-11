/** Synthetic renderer-only measurements. Host polling is disabled, not product polling. */
import {useAppStore} from '../src/renderer/src/store/appStore';
import {mergeBotMessageEvent} from '../src/renderer/src/store/app/slices/botMessageStream';
import {works as fixtureWorks} from './bot-activity-fixtures';
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
        messageId:'message-'+i,ordinal:i+1,role:i%2?'assistant':'user',status:i===n-1?'queued':'completed',messageRevision:1,workIds:[],
        createdAt:1700000000000+i,updatedAt:1700000000000+i,
        text:i%2?(`## Answer ${i}\n\nA paragraph with **bold**, _emphasis_, and inline code. 中文内容用于验证真实排版。\n\n- First item\n- Second item\n\n`).repeat(4):'Question '+i}));
      useAppStore.setState({botHistories:{bot:{botId:'bot',conversationId:'perf-'+n,revision:1,archived:false,messages}},
        botDraft:'',botHistoryPages:{},refreshBotHistory:async()=>{}});
      await paint();if(document.querySelectorAll('[data-message-id="message-1"] .md ul').length!==4)throw Error('fixture did not render multiline Markdown lists');return result('seed');
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
      const next={...m,status:'running' as const,messageRevision:(m.messageRevision??0)+1,text:m.text+' more'};
      useAppStore.setState({botHistories:{bot:mergeBotMessageEvent(h,{botId:h.botId,conversationId:h.conversationId!,revision:h.revision+1,message:next})!}});
      if(useAppStore.getState().botHistories.bot.messages.at(-1)?.text!==next.text)throw Error('stream merge lost content');
      await paint();return result('stream');
    },
    async boundaries() {
      // These checks deliberately keep unchanged message/Work object identities.
      const old=useAppStore.getState().botHistories.bot;loaded=10;
      useAppStore.setState({botHistories:{bot:{...old,messages:old.messages.slice(0,10)}},botWorks:[]});await paint();
      const renders: Record<string,number>={};
      const patch=async(id:string,change:Partial<BotMessageDto>)=>{
        const h=useAppStore.getState().botHistories.bot;begin();
        useAppStore.setState({botHistories:{bot:{...h,revision:h.revision+1,messages:h.messages.map(m=>m.messageId===id?{...m,...change}:m)}}});
        await paint();return counters.messageRenderCount;
      };
      const node=(id:string)=>document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
      const stable=node('message-3');
      renders.oneMessage=await patch('message-1',{text:'Updated reply',status:'running',createdAt:Date.now()});
      if(node('message-3')!==stable || !node('message-1').textContent?.includes('Updated reply'))throw Error('stream sibling identity/content');
      const label=node('message-1').querySelector('.generation-speed-label')!.textContent;
      begin();await new Promise(resolve=>setTimeout(resolve,1100));await paint();
      if(node('message-1').querySelector('.generation-speed-label')!.textContent===label)throw Error('memo froze local generation clock');
      renders.localClock=counters.messageRenderCount;
      for(const status of ['queued','unknown','failed','cancelled','completed'] as const){
        await patch('message-1',{status});
        if(Boolean(node('message-1').querySelector('.bot-message-stop'))!==['queued','unknown'].includes(status))throw Error('stale stop status '+status);
      }
      await patch('message-1',{metrics:{evidenceVersion:1,reportedCalls:1,totalInputTokens:120,contextTokens:null,contextWindow:null,contextEstimated:false,inputTokens:100,cacheReadTokens:20,cacheWriteTokens:0,outputTokens:42,generation:{phase:'complete',estimated:false,tps:40,outputTokens:42,startedAt:1,updatedAt:2,ttftMs:10,outcome:'completed'}}});
      if(!node('message-1').querySelector('.bot-reply-metrics')?.textContent?.includes('输出 42') || !node('message-1').querySelector('.generation-speed')?.textContent?.includes('平均 40.0'))throw Error('stale usage/speed metrics');
      renders.question=await patch('message-0',{text:'Updated source question'});
      if(!node('message-1').querySelector('.bot-reply-reference')?.textContent?.includes('Updated source question'))throw Error('stale source question');
      const work={...fixtureWorks[0],workId:'perf-work',ownerBotId:'bot',title:'Work title one',executions:[]};
      const other={...work,workId:'perf-other',title:'Other work'};
      await patch('message-0',{workIds:['perf-work']});await patch('message-1',{workIds:['perf-work']});
      useAppStore.setState({botWorks:[work,other]});await paint();
      const messages=useAppStore.getState().botHistories.bot.messages;
      begin();useAppStore.setState({botWorks:[work,other]});await paint();renders.sameWorks=counters.messageRenderCount;
      begin();useAppStore.setState({botWorks:[other,work]});await paint();renders.reorderedWorks=counters.messageRenderCount;
      const revised={...work,title:'Work title two'};
      useAppStore.setState({botWorks:[other,revised]});await paint();
      if(!node('message-0').querySelector('.bot-message-work-links')?.textContent?.includes('Work title two'))throw Error('stale Work title');
      if(node('message-1').querySelector('.bot-message-work-links'))throw Error('duplicate question Work link');
      useAppStore.setState({botWorks:[other]});await paint();
      if(!node('message-0').querySelector('.bot-message-work-links')?.textContent?.includes('查看关联事项'))throw Error('removed Work title stayed cached');
      if(useAppStore.getState().botHistories.bot.messages!==messages)throw Error('Work checks replaced messages');
      node('message-0').querySelector<HTMLButtonElement>('.bot-message-reply')!.click();await paint();
      if(!document.querySelector('.bot-composer-context')?.textContent?.includes('Updated source question'))throw Error('stale reply callback');
      document.querySelector<HTMLButtonElement>('[aria-label="取消引用"]')!.click();await paint();
      const calls:string[]=[];const originalCancel=useAppStore.getState().cancelBotSend;
      useAppStore.setState({cancelBotSend:async(botId,requestId)=>{calls.push(botId+':'+requestId);}});
      try {
        await patch('message-1',{status:'running'});
        node('message-1').querySelector<HTMLButtonElement>('.bot-message-stop')!.click();
        if(calls.join()!=='bot:req-0')throw Error('stale cancel callback target');
      }finally{useAppStore.setState({cancelBotSend:originalCancel});}
      await patch('message-1',{status:'completed'});
      // A changed Work projection must refresh result attachments with the same message.
      await patch('message-5',{workIds:['perf-work'],text:'Result body',workFeedback:{workId:'perf-work',eventId:'result',kind:'result',category:'decision',report:{title:'Fixture result',summary:'Result body',current:true,reviewStatus:'accepted',artifactRefs:['/synthetic/result.md'],notices:[]}}});
      useAppStore.setState({botWorks:[{...revised,generatedArtifacts:[{bindingId:'fixture',path:'/synthetic/result.md',snapshotPath:'/saved/result.md',digest:'fixture',sizeBytes:1}]}] as never});await paint();
      if(!node('message-5').querySelector('[aria-label="打开 result.md"]'))throw Error('new result attachment not available');
      const resultMessage=useAppStore.getState().botHistories.bot.messages[5];
      useAppStore.setState({botWorks:[revised]});await paint();
      if(node('message-5').querySelector('[aria-label="打开 result.md"]') || useAppStore.getState().botHistories.bot.messages[5]!==resultMessage)throw Error('stale result attachment');
      await patch('message-7',{text:'Progress one',workFeedback:{workId:'perf-work',eventId:'progress',kind:'binding',category:'progress'}});
      const progress=node('message-7').closest<HTMLDetailsElement>('.bot-work-progress')!;progress.open=true;
      if(node('message-7').querySelector('.bot-message-reply'))throw Error('progress gained reply action');
      await patch('message-9',{text:'Another message stream',status:'running'});
      await patch('message-7',{text:'Progress two'});
      if(!progress.open || node('message-7').closest('.bot-work-progress')!==progress || !node('message-7').textContent?.includes('Progress two'))throw Error('progress fold/content lost');
      return renders;
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
      useAppStore.setState({artifactRenderCache:{}});
      useAppStore.setState({botHistories:{bot:{...h,messages:h.messages.map(m=>m.messageId==='message-1'?{...m,
        text:'![fixture image](synthetic.svg)',reportImages:{taskId:'image-task',sources:{'synthetic.svg':'perf-image'},artifacts:[{
          id:'perf-image',taskId:'image-task',kind:'svg',version:1,capabilities:{},createdAt:1,updatedAt:1,
          source:{type:'managed-content',storagePath:'synthetic.svg',rootDir:'/synthetic'},title:'synthetic.svg'}]},
        botCalls:[{callId:'call-fixture',sourceBotId:'bot',targetBotId:'other',sourceDisplayName:'Source',targetDisplayName:'Target',
          status:'completed',requestText:'Question',replyText:'Answer'}] as never}:m)}}});
      await paint();const stable=useAppStore.getState().botHistories.bot.messages;
      if(target().querySelector<HTMLImageElement>('img.chat-inline-image')?.src.startsWith('blob:'))throw Error('image fixture unexpectedly prehydrated');
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
      const before=useAppStore.getState().botHistories.bot,last=before.messages.at(-1)!;
      useAppStore.setState({botHistories:{bot:{...before,messages:before.messages.map(m=>m===last?{...m,text:m.text+' streaming beside preview'}:m)}}});await paint();
      if(!fold.open || !document.querySelector<HTMLDialogElement>('dialog[aria-label="报告原图"]')?.open)throw Error('stream reset fold or preview state');
      document.querySelector<HTMLButtonElement>('dialog[aria-label="报告原图"] button')!.click();await paint();
      if(document.querySelector('dialog[aria-label="报告原图"]'))throw Error('image local preview did not close');
    },
    transcript: () => document.querySelector('.bot-message-list')!.innerHTML,
    streamTranscript: () => {
      const copy=document.querySelector('.bot-message-list')!.cloneNode(true) as HTMLElement;
      // A separately tested leaf clock/useId is time-dependent, unlike message content.
      copy.querySelectorAll('.generation-speed').forEach(node=>{node.removeAttribute('aria-describedby');node.setAttribute('aria-label','[clock]');node.textContent='[clock]';});
      return copy.innerHTML;
    },
  }});
}
