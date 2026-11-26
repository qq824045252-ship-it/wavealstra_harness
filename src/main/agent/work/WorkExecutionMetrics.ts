import type Database from 'better-sqlite3';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { DurableBotSnapshot } from '../../../shared/durable-bot';
import type { WorkExecutionBindingDto, WorkExecutionMetrics } from '../../../shared/bot-work';
import { enqueueWorkOp, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites } from './WorkDomainRuntime';

type UsagePresence = {input:boolean;output:boolean;cacheRead:boolean;cacheWrite:boolean;totalInput?:boolean};
type UsageEvidence = {inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;totalInputTokens:number|null;observed:boolean};

/** Measurement only. Never governs execution, budget, or task completion. */
export class WorkExecutionMetricsStore {
  constructor(private db: Database.Database) {
    if (!db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS work_execution_metrics(
        binding_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
        started_at INTEGER NOT NULL, value_json TEXT, dirty INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS work_execution_usage(
        binding_id TEXT NOT NULL, call_key TEXT NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY(binding_id,call_key));
        CREATE TABLE IF NOT EXISTS work_execution_timings(binding_id TEXT NOT NULL,message_id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(binding_id,message_id));`);
    }
  }
  begin(binding: WorkExecutionBindingDto): void {
    // Only a fresh, dedicated Work execution may own task-wide provider callbacks.
    const dedicated=this.db.prepare('SELECT 1 FROM work_dispatch_requests WHERE task_id=? AND work_id=?').get(binding.taskId,binding.workId);
    if (!dedicated) return;
    const now=Date.now();
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db,'work_execution_metrics',binding.bindingId,()=>
        this.db.prepare('SELECT * FROM work_execution_metrics WHERE binding_id=?').get(binding.bindingId) as Record<string,unknown>|undefined,
      cur=>cur??{binding_id:binding.bindingId,task_id:binding.taskId,conversation_id:binding.conversationId,started_at:now,value_json:null,dirty:0});
      enqueueWorkOp(this.db,{op:'workExecMetricsBegin',bindingId:binding.bindingId,taskId:binding.taskId,conversationId:binding.conversationId,startedAt:now});
      return;
    }
    this.db.prepare('INSERT OR IGNORE INTO work_execution_metrics(binding_id,task_id,conversation_id,started_at) VALUES(?,?,?,?)')
      .run(binding.bindingId,binding.taskId,binding.conversationId,now);
  }
  private owner(taskId:string) {
    const dbRows=this.db.prepare('SELECT binding_id,task_id,conversation_id,started_at,value_json,dirty FROM work_execution_metrics WHERE task_id=?').all(taskId) as
      Array<{binding_id:string;task_id:string;conversation_id:string;started_at:number;value_json:string|null;dirty:number}>;
    const rows=overlayFindAll(this.db,'work_execution_metrics',dbRows,r=>r.binding_id,r=>r.task_id===taskId);
    return rows[0];
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
    const pk=`${owner.binding_id}\0${key}`;
    const previous=overlayReadOne<{value_json:string}>(this.db,'work_execution_usage',pk,()=>
      this.db.prepare('SELECT value_json FROM work_execution_usage WHERE binding_id=? AND call_key=?').get(owner.binding_id,key) as {value_json:string}|undefined);
    if(previous && JSON.parse(previous.value_json).usageEvidence?.observed && !input.usageEvidence?.observed)return;
    const valueJson=JSON.stringify(input);
    if(requiresWorkRustWrites(this.db)) {
      overlaySet(this.db,'work_execution_usage',pk,{binding_id:owner.binding_id,call_key:key,value_json:valueJson});
      enqueueWorkOp(this.db,{op:'workExecMetricsUsageUpsert',bindingId:owner.binding_id,callKey:key,valueJson});
      return;
    }
    this.db.prepare('INSERT OR REPLACE INTO work_execution_usage VALUES(?,?,?)').run(owner.binding_id,key,valueJson);
  }
  consumeChange(bindingId:string):boolean {
    if(requiresWorkRustWrites(this.db)) {
      let changed=false;
      overlayMutate(this.db,'work_execution_metrics',bindingId,()=>
        this.db.prepare('SELECT * FROM work_execution_metrics WHERE binding_id=?').get(bindingId) as Record<string,unknown>|undefined,
      cur=>{if(!cur || cur.dirty!==1)return cur;changed=true;return{...cur,dirty:0};});
      if(changed) enqueueWorkOp(this.db,{op:'workExecMetricsClearDirty',bindingId});
      return changed;
    }
    return this.db.prepare('UPDATE work_execution_metrics SET dirty=0 WHERE binding_id=? AND dirty=1').run(bindingId).changes>0;
  }
  read(bindingId:string):WorkExecutionMetrics|undefined {
    const row=overlayReadOne<{value_json:string|null}>(this.db,'work_execution_metrics',bindingId,()=>
      this.db.prepare('SELECT value_json FROM work_execution_metrics WHERE binding_id=?').get(bindingId) as {value_json:string|null}|undefined);
    return row?.value_json ? JSON.parse(row.value_json) : undefined;
  }
  project(taskId:string,snapshot:DurableBotSnapshot):void {
    const owner=this.owner(taskId); if(!owner || String(snapshot.conversationId)!==owner.conversation_id)return;
    const rust=requiresWorkRustWrites(this.db);
    const dbCalls=this.db.prepare('SELECT binding_id,call_key,value_json FROM work_execution_usage WHERE binding_id=?').all(owner.binding_id) as {binding_id:string;call_key:string;value_json:string}[];
    const calls=overlayFindAll(this.db,'work_execution_usage',dbCalls,r=>`${r.binding_id}\0${r.call_key}`,r=>r.binding_id===owner.binding_id)
      .map(row=>JSON.parse(row.value_json) as {conversationId:string;reported:boolean;usagePresence?:UsagePresence;usageEvidence?:UsageEvidence;inputTokens?:number|null;outputTokens?:number|null;cacheReadTokens?:number|null;cacheWriteTokens?:number|null;totalInputTokens?:number|null});
    const usable=(key:'inputTokens'|'outputTokens'|'cacheReadTokens'|'cacheWriteTokens'|'totalInputTokens')=>calls.length>0 && calls.every(call=>call.reported && call.usagePresence?.[key.replace('Tokens','') as keyof UsagePresence]===true && Number.isFinite(call[key]) && call[key]!>=0);
    const sum=(key:'inputTokens'|'outputTokens'|'cacheReadTokens'|'cacheWriteTokens'|'totalInputTokens')=>usable(key)?calls.reduce((n,call)=>n+call[key]!,0):null;
    const replies=snapshot.messages.filter(row=>row.role==='assistant');
    for(const reply of replies) if(reply.generationStats?.phase==='complete') {
      const valueJson=JSON.stringify(reply.generationStats);
      if(rust) {
        overlaySet(this.db,'work_execution_timings',`${owner.binding_id}\0${reply.id}`,{binding_id:owner.binding_id,message_id:reply.id,value_json:valueJson});
        enqueueWorkOp(this.db,{op:'workExecMetricsTimingUpsert',bindingId:owner.binding_id,messageId:reply.id,valueJson});
      } else this.db.prepare('INSERT OR REPLACE INTO work_execution_timings VALUES(?,?,?)').run(owner.binding_id,reply.id,valueJson);
    }
    const last=replies.at(-1);
    const dbTimings=this.db.prepare('SELECT binding_id,message_id,value_json FROM work_execution_timings WHERE binding_id=?').all(owner.binding_id) as {binding_id:string;message_id:string;value_json:string}[];
    const timings=overlayFindAll(this.db,'work_execution_timings',dbTimings,r=>`${r.binding_id}\0${r.message_id}`,r=>r.binding_id===owner.binding_id)
      .map(row=>JSON.parse(row.value_json) as NonNullable<WorkExecutionMetrics['generation']>).filter(timing=>timing.phase==='complete').sort((a,b)=>a.startedAt-b.startedAt);
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
    const valueJson=JSON.stringify(value);
    if(rust) {
      overlayMutate(this.db,'work_execution_metrics',owner.binding_id,()=>
        this.db.prepare('SELECT * FROM work_execution_metrics WHERE binding_id=?').get(owner.binding_id) as Record<string,unknown>|undefined,
      cur=>cur?{...cur,value_json:valueJson,dirty:1}:cur);
      enqueueWorkOp(this.db,{op:'workExecMetricsSetValue',bindingId:owner.binding_id,valueJson});
      return;
    }
    this.db.transaction(()=>{
      this.db.prepare('UPDATE work_execution_metrics SET value_json=?,dirty=1 WHERE binding_id=?').run(valueJson,owner.binding_id);
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
