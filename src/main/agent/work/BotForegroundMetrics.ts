import { emptyUsageEvidence, type ProviderUsageEvidence } from "../../../shared/provider-usage-evidence";
import type Database from 'better-sqlite3';
import type { DurableBotSnapshot } from '../../../shared/durable-bot';
import type { BotForegroundMetrics } from '../../../shared/bot-conversation';
import { enqueueWorkOp, overlayFindAll, overlayReadOne, overlaySet, requiresWorkRustWrites } from './WorkDomainRuntime';

/** One foreground reply only. Imported context and sibling requests are never billed here. */
export class BotForegroundMetricsStore {
  constructor(private db: Database.Database) {
    if (!db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS bot_foreground_metrics(message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE, value_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bot_foreground_usage(message_id TEXT NOT NULL REFERENCES bot_messages(message_id) ON DELETE CASCADE, generation_id INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(message_id,generation_id));`);
    }
  }
  usage(messageId: string, input: {generationTaskId:number;responseTimestamp?:number;reported:boolean;inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;usageEvidence?:ProviderUsageEvidence}) {
    const evidence=input.usageEvidence??emptyUsageEvidence();
    const record={...input,normalizedUsage:{inputTokens:input.inputTokens,outputTokens:input.outputTokens,cacheReadTokens:input.cacheReadTokens,cacheWriteTokens:input.cacheWriteTokens},...evidence,reported:input.reported && evidence.observed};
    const key=input.responseTimestamp===undefined?String(input.generationTaskId):`${input.generationTaskId}:${input.responseTimestamp}`;
    const pk=`${messageId}\0${key}`;
    const prior=overlayReadOne<{value_json:string}>(this.db,'bot_foreground_usage',pk,()=>this.db.prepare('SELECT value_json FROM bot_foreground_usage WHERE message_id=? AND generation_id=?').get(messageId,key) as {value_json:string}|undefined);
    // Durable replay has no fresh HTTP stream; never erase the original receipt.
    if(prior && JSON.parse(prior.value_json).observed)return;
    const valueJson=JSON.stringify(record);
    if(requiresWorkRustWrites(this.db)) {
      overlaySet(this.db,'bot_foreground_usage',pk,{message_id:messageId,generation_id:key,value_json:valueJson});
      enqueueWorkOp(this.db,{op:'botForegroundUsageUpsert',messageId,generationId:key,valueJson});
      return;
    }
    this.db.prepare('INSERT OR REPLACE INTO bot_foreground_usage VALUES(?,?,?)').run(messageId,key,valueJson);
  }
  read(messageId:string): BotForegroundMetrics|undefined {
    const row=overlayReadOne<{value_json:string}>(this.db,'bot_foreground_metrics',messageId,()=>this.db.prepare('SELECT value_json FROM bot_foreground_metrics WHERE message_id=?').get(messageId) as {value_json:string}|undefined);
    if(!row)return undefined;
    const value=JSON.parse(row.value_json) as BotForegroundMetrics;
    // Older records did not distinguish absent raw fields from SDK zero defaults.
    return value.evidenceVersion===1?value:{...value,inputTokens:null,totalInputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,contextTokens:null};
  }
  project(messageId:string,requestId:string,snapshot:DurableBotSnapshot):BotForegroundMetrics|undefined {
    let index=snapshot.messages.length-1;
    while(index>=0 && snapshot.messages[index].role!=='user') index--;
    if(index<0 || snapshot.messages[index].botRequestId!==requestId) return;
    const replies=snapshot.messages.slice(index+1).filter(row=>row.role==='assistant');
    const reply=replies.at(-1);
    let generation=reply?.generationStats;
    const timings=replies.map(row=>row.generationStats);
    if(timings.length && timings.every(timing=>timing?.phase==='complete')) {
      const settled=timings.map(timing=>timing!);
      const measured=settled.every(timing=>timing.outputTokens!=null && (timing.outputTokens===0 || (timing.tps!=null && timing.tps>0)));
      const outputs=settled.every(timing=>timing.outputTokens!=null)?settled.reduce((sum,timing)=>sum+timing.outputTokens!,0):null;
      const seconds=measured?settled.reduce((sum,timing)=>sum+(timing.outputTokens ? timing.outputTokens/timing.tps! : 0),0):0;
      generation={...generation!,startedAt:settled[0].startedAt,ttftMs:settled[0].ttftMs,
        outputTokens:outputs,tps:measured && seconds>0 && outputs!=null?outputs/seconds:null};
    }
    const dbCalls=this.db.prepare('SELECT message_id,generation_id,value_json FROM bot_foreground_usage WHERE message_id=?').all(messageId) as {message_id:string;generation_id:string;value_json:string}[];
    const calls=overlayFindAll(this.db,'bot_foreground_usage',dbCalls,r=>`${r.message_id}\0${r.generation_id}`,r=>r.message_id===messageId).map(row=>JSON.parse(String(row.value_json)) as ProviderUsageEvidence & {reported:boolean;responseTimestamp?:number});
    const sum=(key:'inputTokens'|'totalInputTokens'|'outputTokens'|'cacheReadTokens'|'cacheWriteTokens')=>calls.length && calls.every(call=>call.reported && call[key]!=null)?calls.reduce((total,call)=>total+call[key]!,0):null;
    const context=snapshot.contextUsage;
    if(sum('outputTokens')===null && generation?.phase==='complete') generation={...generation,tps:null,outputTokens:null};
    const last=calls.filter(call=>call.responseTimestamp!==undefined).sort((a,b)=>a.responseTimestamp!-b.responseTimestamp!).at(-1);
    const used=last?.reported && last.totalInputTokens!=null && last.outputTokens!=null?last.totalInputTokens+last.outputTokens:null;
    const value:BotForegroundMetrics={evidenceVersion:1,totalInputTokens:sum('totalInputTokens'),inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),cacheReadTokens:sum('cacheReadTokens'),cacheWriteTokens:sum('cacheWriteTokens'),reportedCalls:calls.filter(call=>call.reported).length,
      contextTokens:used,contextWindow:context?.contextWindow??null,contextEstimated:context?.estimated??true,
      generation,modelName:reply?.modelName,durationMs:generation?.phase==='complete'?Math.max(0,generation.updatedAt-generation.startedAt):undefined};
    if(JSON.stringify(this.read(messageId))!==JSON.stringify(value)) {
      const valueJson=JSON.stringify(value);
      if(requiresWorkRustWrites(this.db)) {
        overlaySet(this.db,'bot_foreground_metrics',messageId,{message_id:messageId,value_json:valueJson});
        enqueueWorkOp(this.db,{op:'botForegroundMetricsUpsert',messageId,valueJson});
      } else this.db.prepare('INSERT OR REPLACE INTO bot_foreground_metrics VALUES(?,?)').run(messageId,valueJson);
    }
    return value;
  }
}
