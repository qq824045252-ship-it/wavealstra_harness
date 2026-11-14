import {useEffect,useRef,useState} from 'react';
import type {BotIncomingMessage} from '@shared/bot-collaboration';
export function mergeIncomingMessages(old:readonly BotIncomingMessage[], next:readonly BotIncomingMessage[]):BotIncomingMessage[] {
 return [...new Map([...old,...next].map(x=>[x.message.messageId,x])).values()].sort((a,b)=>a.message.createdAt-b.message.createdAt || (a.message.messageId<b.message.messageId?-1:a.message.messageId>b.message.messageId?1:0));
}
export function useBotIncomingMessages(botId:string|undefined, membershipKey = '') {
 const [items,setItems]=useState<BotIncomingMessage[]>([]), [before,setBefore]=useState<string|null>(null), [error,setError]=useState(''),[loading,setLoading]=useState(false);
 const refreshOffset=useRef(0);
 const itemsRef=useRef<BotIncomingMessage[]>([]);itemsRef.current=items;
 const scope=JSON.stringify([botId,membershipKey]);
 const publishedScope=useRef<string|undefined>(undefined);
 const generation=useRef(0), flight=useRef(false), latest=useRef<string|undefined>(undefined);
 const read=useRef<(older?:string)=>Promise<void>>(async()=>{});
 useEffect(()=>{const epoch=++generation.current;setItems([]);setBefore(null);setError('');setLoading(false);latest.current=undefined;flight.current=false;refreshOffset.current=0;
  read.current=async(older)=>{if(!botId || flight.current)return;flight.current=true;setLoading(true);
   try { const api=window.api?.botWork.incomingMessages;if(!api)throw new Error('协作消息接口不可用，请重启更新后的应用。');
    const after=older?undefined:latest.current;const page=await api({botId,before:older,after,limit:100});
    if(epoch!==generation.current)return;
    publishedScope.current=scope;
    setItems(previous=>mergeIncomingMessages(previous,page.items));
    if(!after)setBefore(page.nextCursor);
    if(!older && page.items.length)latest.current=page.items.at(-1)!.cursor;
    const unresolved=itemsRef.current.filter(item=>item.message.kind!=='request');
    const start=unresolved.length?refreshOffset.current%unresolved.length:0;
    const refreshIds=older?[]:[...unresolved.slice(start),...unresolved.slice(0,start)].slice(0,100).map(item=>item.message.messageId);
    if(!older)refreshOffset.current=start+refreshIds.length;
    if(refreshIds.length){const updates=await api({botId,refreshIds});if(epoch!==generation.current)return;setItems(previous=>mergeIncomingMessages(previous,updates.items));}
    setError('');
   }catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:String(e));}
   finally{if(epoch===generation.current){flight.current=false;setLoading(false);}}
  };
  void read.current();const timer=setInterval(()=>{if(!document.hidden)void read.current();},2000);
  return()=>{generation.current++;clearInterval(timer);};
 },[botId,membershipKey]);
 return {items:publishedScope.current===scope?items:[],before:publishedScope.current===scope?before:null,error,loading,initialLoading:Boolean(botId)&&publishedScope.current!==scope&&!error,more:()=>before?read.current(before):Promise.resolve(),retry:()=>read.current(),retrySummary:async(id:string)=>{
  if(!botId||flight.current)return;const epoch=generation.current;flight.current=true;setLoading(true);
  try{const api=window.api?.botWork?.incomingMessages;if(!api)throw Error("主机离线，请稍后重试");const page=await api({botId,refreshIds:[id],retrySummaryIds:[id]});if(epoch===generation.current)setItems(old=>mergeIncomingMessages(old,page.items));}
  catch(error){if(epoch===generation.current)setError(error instanceof Error?error.message:String(error));}
  finally{if(epoch===generation.current){flight.current=false;setLoading(false);}}
 }};
}
