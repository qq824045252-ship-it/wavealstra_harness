import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BotIncomingMessage } from '../../../shared/bot-collaboration';
export const incomingSummaryHash = (item: BotIncomingMessage) => createHash('sha256').update(JSON.stringify([item.message, item.collaboration.sourceBotId])).digest('hex');
type State = { hash:string; status:string; text:string; error:string; attempts:number; retry_at:number; lease:string };
interface Options {
 db: Database.Database; userId:string; authority:()=>boolean;
 read:(botId:string,messageId:string)=>BotIncomingMessage|undefined;
 generate:(item:BotIncomingMessage,signal:AbortSignal)=>Promise<string>;
 now?:()=>number;
}
/** A separate, text-only derivative. Never calls foreground/Work/peer delivery. */
export class BotIncomingSummary {
 private queue=new Map<string,{botId:string;id:string}>();
 private running=false; private closed=false; private abort=new AbortController();
 constructor(private options:Options){options.db.exec(`CREATE TABLE IF NOT EXISTS bot_incoming_summaries(
 user_id TEXT NOT NULL,message_id TEXT NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,lease TEXT NOT NULL DEFAULT '',PRIMARY KEY(user_id,message_id));`);}
 close(){this.closed=true;this.queue.clear();this.abort.abort();}
 private now(){return this.options.now?.()??Date.now();}
 private state(id:string){return this.options.db.prepare('SELECT * FROM bot_incoming_summaries WHERE user_id=? AND message_id=?').get(this.options.userId,id) as State|undefined;}
 offer(botId:string,items:BotIncomingMessage[],retryIds:readonly string[]=[]){
  for(const item of items){
   if(item.message.kind==='request' || item.message.workFeedback?.report?.summary || (item.summary && !item.summary.generated && !['failed','cancelled','unknown'].includes(item.summary.status)))continue;
   const id=item.message.messageId,hash=incomingSummaryHash(item);let state=this.state(id);
   if(!this.options.authority() || this.closed){if(state?.hash===hash)item.summary={text:state.text,status:state.status,senderBotId:item.collaboration.sourceBotId,senderDisplayName:item.collaboration.sourceDisplayName,generated:true,error:state.error||undefined};continue;}
   if(!state || state.hash!==hash){this.options.db.prepare(`INSERT INTO bot_incoming_summaries(user_id,message_id,hash,status) VALUES (?,?,?,'queued') ON CONFLICT(user_id,message_id) DO UPDATE SET hash=excluded.hash,status='queued',text='',error='',attempts=0,retry_at=0,lease=''`).run(this.options.userId,id,hash);state=this.state(id);}
   if(state?.status==='running' && state.retry_at<=this.now() && state.attempts>=3){this.options.db.prepare("UPDATE bot_incoming_summaries SET status='failed',error='整理中断达到重试上限，请手动重试' WHERE user_id=? AND message_id=?").run(this.options.userId,id);state=this.state(id);}
   if(retryIds.includes(id) && state?.status==='failed'){this.options.db.prepare("UPDATE bot_incoming_summaries SET status='queued',attempts=0,retry_at=0,error='' WHERE user_id=? AND message_id=? AND status='failed'").run(this.options.userId,id);state=this.state(id);}
   if(state?.status!=='completed' && (state?.retry_at??0)<=this.now() && (state?.attempts??0)<3 && this.queue.size<100)this.queue.set(id,{botId,id});
   if(state)item.summary={text:state.text,status:state.status,senderBotId:item.collaboration.sourceBotId,senderDisplayName:item.collaboration.sourceDisplayName,generated:true,error:state.error||undefined};
  }
  void this.drain().catch(error=>console.warn('[Bot] 历史整理队列暂停',error));
 }
 async drain():Promise<void>{
  if(this.running||this.closed||!this.options.authority())return;this.running=true;
  try {while(this.queue.size && !this.closed && this.options.authority()){
   const [id,job]=this.queue.entries().next().value!;this.queue.delete(id);
   let item:BotIncomingMessage|undefined;try{item=this.options.read(job.botId,id);}catch{continue;}if(!item)continue;
   const hash=incomingSummaryHash(item),lease=randomUUID();
   if(item.summary?.status==='completed'&&!item.summary.generated)continue;
   const acquired=this.options.db.prepare(`UPDATE bot_incoming_summaries SET status='running',attempts=attempts+1,lease=?,retry_at=? WHERE user_id=? AND message_id=? AND hash=? AND status!='completed' AND attempts<3 AND retry_at<=?`).run(lease,this.now()+180000,this.options.userId,id,hash,this.now());
   if(!acquired.changes)continue;
   try{
    const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(120000)]);
    let abortListener:()=>void=()=>{};
    const aborted=new Promise<never>((_resolve,reject)=>{abortListener=()=>reject(signal.reason);signal.addEventListener('abort',abortListener,{once:true});if(signal.aborted)abortListener();});
    let text:string;try{text=(await Promise.race([this.options.generate(item,signal),aborted])).trim();}finally{signal.removeEventListener('abort',abortListener);}
    signal.throwIfAborted();if(!text)throw new Error('模型没有返回整理正文');
    const current=this.options.read(job.botId,id);
    if(this.closed||!this.options.authority()||!current||incomingSummaryHash(current)!==hash)continue;
    this.options.db.prepare("UPDATE bot_incoming_summaries SET status='completed',text=?,error='',retry_at=0 WHERE user_id=? AND message_id=? AND hash=? AND lease=?").run(text,this.options.userId,id,hash,lease);
   }catch(error){if(this.closed)continue;const attempts=this.state(id)?.attempts??3;this.options.db.prepare("UPDATE bot_incoming_summaries SET status='failed',error=?,retry_at=? WHERE user_id=? AND message_id=? AND hash=? AND lease=?").run(error instanceof Error?error.message:String(error),this.now()+Math.min(60000,10000*2**attempts),this.options.userId,id,hash,lease);}
  }}finally{this.running=false;}
 }
}
