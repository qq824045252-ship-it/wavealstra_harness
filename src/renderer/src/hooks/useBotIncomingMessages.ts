import {useEffect, useRef, useState} from 'react';
import type {BotCollaborationDto, BotIncomingMessage} from '@shared/bot-collaboration';

export function mergeIncomingMessages(old: readonly BotIncomingMessage[], next: readonly BotIncomingMessage[], older = false): BotIncomingMessage[] {
 const relations = new Map<string, BotCollaborationDto>();
 // An older page must not replace an equally recent relation already observed.
 for (const item of older ? [...next, ...old] : [...old, ...next]) {
  const relation = item.collaboration;
  const key = JSON.stringify([relation.targetBotId, relation.collaborationId]);
  const previous = relations.get(key);
  if (!previous || (relation.updatedAt ?? 0) >= (previous.updatedAt ?? 0)) relations.set(key, relation);
 }
 return [...new Map([...old, ...next].map(item => [item.message.messageId, item])).values()]
  .map(item => ({...item, collaboration: relations.get(JSON.stringify([item.collaboration.targetBotId, item.collaboration.collaborationId]))!}))
  .sort((a,b) => a.message.createdAt-b.message.createdAt || (a.message.messageId<b.message.messageId?-1:a.message.messageId>b.message.messageId?1:0));
}

export function useBotIncomingMessages(botId: string | undefined, membershipKey = '') {
 const [items,setItems]=useState<BotIncomingMessage[]>([]), [before,setBefore]=useState<string|null>(null), [error,setError]=useState(''), [loading,setLoading]=useState(false);
 const refreshOffset=useRef(0), itemsRef=useRef<BotIncomingMessage[]>([]);
 const scope=JSON.stringify([botId,membershipKey]);
 const currentScope=useRef(scope); currentScope.current=scope;
 const publishedScope=useRef<string|undefined>(undefined);
 const generation=useRef(0), flight=useRef(false), latest=useRef<string|undefined>(undefined);
 const read=useRef<(older?:string)=>Promise<void>>(async()=>{});
 useEffect(()=>{
  const epoch=++generation.current;
  const active=()=>epoch===generation.current && currentScope.current===scope;
  const publish=(next:readonly BotIncomingMessage[], older=false)=>{
   if (!next.length) return;
   itemsRef.current=mergeIncomingMessages(itemsRef.current,next,older);
   setItems(itemsRef.current);
  };
  itemsRef.current=[];setItems([]);setBefore(null);setError('');setLoading(false);latest.current=undefined;flight.current=false;refreshOffset.current=0;
  read.current=async(older)=>{
   if(!botId || !active() || flight.current)return;
   flight.current=true;setLoading(true);
   try {
    const api=window.api?.botWork.incomingMessages;
    if(!api)throw new Error('协作消息接口不可用，请重启更新后的应用。');
    // Refresh all loaded kinds, including request-only delegations, in bounded rotation.
    const loaded=itemsRef.current;
    const start=loaded.length?refreshOffset.current%loaded.length:0;
    const refreshIds=older?[]:[...loaded.slice(start),...loaded.slice(0,start)].slice(0,100).map(item=>item.message.messageId);
    const after=older?undefined:latest.current;
    const page=await api({botId,before:older,after,limit:100});
    if(!active())return;
    publishedScope.current=scope;publish(page.items,Boolean(older));
    if(!after)setBefore(page.nextCursor);
    // The host cursor is insertion order, not the display's createdAt ordering.
    if(!older && page.items.length)latest.current=page.items.at(-1)!.cursor;
    if(!older)refreshOffset.current=start+refreshIds.length;
    if(refreshIds.length){
     const updates=await api({botId,refreshIds});
     if(!active())return;
     publish(updates.items);
    }
    setError('');
   }catch(e){if(active())setError(e instanceof Error?e.message:String(e));}
   finally{if(active()){flight.current=false;setLoading(false);}}
  };
  void read.current();const timer=setInterval(()=>{if(!document.hidden)void read.current();},2000);
  return()=>{generation.current++;clearInterval(timer);};
 },[botId,membershipKey]);
 return {
  items:publishedScope.current===scope?items:[], before:publishedScope.current===scope?before:null,
  error,loading,initialLoading:Boolean(botId)&&publishedScope.current!==scope&&!error,
  more:()=>currentScope.current===scope && before?read.current(before):Promise.resolve(),
  retry:()=>currentScope.current===scope?read.current():Promise.resolve(),
  retrySummary:async(id:string)=>{
   if(!botId || currentScope.current!==scope || flight.current)return;
   const epoch=generation.current;
   const active=()=>epoch===generation.current && currentScope.current===scope;
   flight.current=true;setLoading(true);
   try{
    const api=window.api?.botWork?.incomingMessages;
    if(!api)throw Error('主机离线，请稍后重试');
    const page=await api({botId,refreshIds:[id],retrySummaryIds:[id]});
    if(active()){itemsRef.current=mergeIncomingMessages(itemsRef.current,page.items);setItems(itemsRef.current);setError('');}
   }catch(error){if(active())setError(error instanceof Error?error.message:String(error));}
   finally{if(active()){flight.current=false;setLoading(false);}}
  }
 };
}
