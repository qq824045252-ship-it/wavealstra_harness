import type Database from 'better-sqlite3';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { DurableBotSnapshot } from '../../../shared/durable-bot';
import type { WorkExecutionBindingDto, WorkExecutionMetrics } from '../../../shared/bot-work';

type UsagePresence = {input:boolean;output:boolean;cacheRead:boolean;cacheWrite:boolean;totalInput?:boolean};
type UsageEvidence = {inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;totalInputTokens:number|null;observed:boolean};

/** Measurement only. Never governs execution, budget, or task completion. */
export class WorkExecutionMetricsStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_execution_metrics(
      binding_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, value_json TEXT, dirty INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS work_execution_usage(
      binding_id TEXT NOT NULL, call_key TEXT NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(binding_id,call_key));
      CREATE TABLE IF NOT EXISTS work_execution_timings(binding_id TEXT NOT NULL,message_id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(binding_id,message_id));`);
  }
  begin(binding: WorkExecutionBindingDto): void {
    // Only a fresh, dedicated Work execution may own task-wide provider callbacks.
    const dedicated=this.db.prepare('SELECT 1 FROM work_dispatch_requests WHERE task_id=? AND work_id=?').get(binding.taskId,binding.workId);
    if (!dedicated) return;
    this.db.prepare('INSERT OR IGNORE INTO work_execution_metrics(binding_id,task_id,conversation_id,started_at) VALUES(?,?,?,?)')
      .run(binding.bindingId,binding.taskId,binding.conversationId,Date.now());
  }
  private owner(taskId:string) {
    return this.db.prepare('SELECT binding_id,conversation_id,started_at FROM work_execution_metrics WHERE task_id=?').get(taskId) as
      {binding_id:string;conversation_id:string;started_at:number}|undefined;
  }
  response(taskId:string,message:AssistantMessage,identity:{conversationId:string;generationTaskId:number;usagePresence?:UsagePresence;usageEvidence?:UsageEvidence}):void {
    this.usage(taskId,{...identity,responseTimestamp:message.timestamp,
      reported:!['error','aborted'].includes(message.stopReason) && Boolean(message.usage),
      inputTokens:message.usage?.input,outputTokens:message.usage?.output,
      cacheReadTokens:message.usage?.cacheRead,cacheWriteTokens:message.usage?.cacheWrite});
  }
  usage(taskId:string,input:{conversationId:string;generationTaskId:number;responseTimestamp?:number;reported:boolean;usagePresence?:UsagePresence;usageEvidence?:UsageEvidence;
    inputTokens?:number|null;outputTokens?:number|null;cacheReadTokens?:number|null;cacheWriteTokens?:number|null;totalInputTokens?:number|null}):void {
    const owner=this.owner(taskId); if(!owner)return;
    input={...input,...(input.usageEvidence??{})};
    input={...input,reported:input.reported && [input.totalInputTokens,input.inputTokens,input.outputTokens,input.cacheReadTokens,input.cacheWriteTokens].some(value=>value!>0)};
    // Conversation + task + response timestamp distinguish child generations and retries.
    const key=JSON.stringify([input.conversationId,input.generationTaskId,input.responseTimestamp??null]);
    const previous=this.db.prepare('SELECT value_json FROM work_execution_usage WHERE binding_id=? AND call_key=?').get(owner.binding_id,key) as {value_json:string}|undefined;
    if(previous && JSON.parse(previous.value_json).usageEvidence?.observed && !input.usageEvidence?.observed)return;
    this.db.prepare('INSERT OR REPLACE INTO work_execution_usage VALUES(?,?,?)').run(owner.binding_id,key,JSON.stringify(input));
  }
  consumeChange(bindingId:string):boolean {
    return this.db.prepare('UPDATE work_execution_metrics SET dirty=0 WHERE binding_id=? AND dirty=1').run(bindingId).changes>0;
  }
  read(bindingId:string):WorkExecutionMetrics|undefined {
    const row=this.db.prepare('SELECT value_json FROM work_execution_metrics WHERE binding_id=?').get(bindingId) as {value_json:string|null}|undefined;
    return row?.value_json ? JSON.parse(row.value_json) : undefined;
  }
  project(taskId:string,snapshot:DurableBotSnapshot):void {
    const owner=this.owner(taskId); if(!owner || String(snapshot.conversationId)!==owner.conversation_id)return;
    const calls=(this.db.prepare('SELECT value_json FROM work_execution_usage WHERE binding_id=?').all(owner.binding_id) as {value_json:string}[])
      .map(row=>JSON.parse(row.value_json) as {conversationId:string;reported:boolean;usagePresence?:UsagePresence;usageEvidence?:UsageEvidence;inputTokens?:number|null;outputTokens?:number|null;cacheReadTokens?:number|null;cacheWriteTokens?:number|null;totalInputTokens?:number|null});
    const usable=(key:'inputTokens'|'outputTokens'|'cacheReadTokens'|'cacheWriteTokens'|'totalInputTokens')=>calls.length>0 && calls.every(call=>call.reported && call.usagePresence?.[key.replace('Tokens','') as keyof UsagePresence]===true && Number.isFinite(call[key]) && call[key]!>=0);
    const sum=(key:'inputTokens'|'outputTokens'|'cacheReadTokens'|'cacheWriteTokens'|'totalInputTokens')=>usable(key)?calls.reduce((n,call)=>n+call[key]!,0):null;
    const replies=snapshot.messages.filter(row=>row.role==='assistant');
    for(const reply of replies) if(reply.generationStats?.phase==='complete') this.db.prepare('INSERT OR REPLACE INTO work_execution_timings VALUES(?,?,?)').run(owner.binding_id,reply.id,JSON.stringify(reply.generationStats));
    const last=replies.at(-1);
    const timings=(this.db.prepare('SELECT value_json FROM work_execution_timings WHERE binding_id=?').all(owner.binding_id) as {value_json:string}[]).map(row=>JSON.parse(row.value_json) as NonNullable<WorkExecutionMetrics['generation']>).filter(timing=>timing.phase==='complete').sort((a,b)=>a.startedAt-b.startedAt);
    let generation=last?.generationStats;
    if(!snapshot.busy && timings.length && timings.every(timing=>timing?.phase==='complete')) {
      const settled=timings.map(timing=>timing!);
      const measured=settled.length===calls.filter(call=>call.conversationId===owner.conversation_id).length && settled.every(timing=>timing.outputTokens!=null && (timing.outputTokens===0 || (timing.tps!=null && timing.tps>0)));
      const outputs=settled.every(timing=>timing.outputTokens!=null)?settled.reduce((n,t)=>n+t.outputTokens!,0):null;
      const seconds=measured?settled.reduce((n,t)=>n+(t.outputTokens?t.outputTokens/t.tps!:0),0):0;
      generation={...generation!,startedAt:settled[0].startedAt,ttftMs:settled[0].ttftMs,outputTokens:outputs,tps:measured&&seconds>0&&outputs!=null?outputs/seconds:null};
    }
    const context=snapshot.contextUsage;
    if(!usable('outputTokens') && generation?.phase==='complete') generation={...generation,outputTokens:null,tps:null};
    const value:WorkExecutionMetrics={inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),totalInputTokens:sum('totalInputTokens'),cacheReadTokens:sum('cacheReadTokens'),cacheWriteTokens:sum('cacheWriteTokens'),
      reportedCalls:calls.filter(call=>call.reported).length,calls:calls.length,
      complete:!snapshot.busy && snapshot.outcome==='completed' && usable('inputTokens') && usable('outputTokens'),
      contextTokens:context?.usedTokens?context.usedTokens:null,contextWindow:context?.contextWindow??null,contextEstimated:context?.estimated??true,
      generation,modelName:last?.modelName,observedAt:Date.now(),
      durationMs:!snapshot.busy && snapshot.outcome ? Math.max(0,(generation?.updatedAt??Date.now())-owner.started_at):undefined};
    const previous=this.read(owner.binding_id);
    if(snapshot.busy && previous && value.observedAt-previous.observedAt<500)return;
    if(previous && JSON.stringify({...previous,observedAt:0})===JSON.stringify({...value,observedAt:0}))return;
    this.db.transaction(()=>{
      this.db.prepare('UPDATE work_execution_metrics SET value_json=?,dirty=1 WHERE binding_id=?').run(JSON.stringify(value),owner.binding_id);
      // Fact-only journal update: does not move Work's control version.
      if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_projection_streams'").get()) {
        const work=this.db.prepare('SELECT w.user_id,w.work_id FROM works w JOIN work_execution_bindings b ON b.work_id=w.work_id WHERE b.binding_id=?').get(owner.binding_id) as {user_id:string;work_id:string}|undefined;
        if(work) {
          this.db.prepare('INSERT OR IGNORE INTO work_projection_streams(user_id) VALUES(?)').run(work.user_id);
          this.db.prepare('UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=?').run(work.user_id);
          this.db.prepare('INSERT INTO work_projection_events(user_id,sequence,work_id) SELECT user_id,sequence,? FROM work_projection_streams WHERE user_id=?').run(work.work_id,work.user_id);
        }
      }
    })();
  }
}
