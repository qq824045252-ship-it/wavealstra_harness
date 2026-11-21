import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, Cursor } from "@earendil-works/pi-durable";
import type Database from "better-sqlite3";
import { openDurablePassiveStorage } from "../durable/DurableStorage";
import type { ImprovementPackages, ImprovementUse } from "./ImprovementPackages";

/** Join the file verifier's result to the answer that actually settled this native submission. */
export async function settleImprovementUses(ledger:Database.Database,packages:ImprovementPackages,task:string,directory:string) {
  const pending=ledger.prepare("SELECT p.* FROM improvement_uses p WHERE p.task=? AND p.kind='hook' AND p.event='passed' AND NOT EXISTS (SELECT 1 FROM improvement_uses a WHERE a.id=p.id AND a.revision=p.revision AND a.task=p.task AND a.conversation=p.conversation AND a.run=p.run AND a.event='accepted')")
    .all(task) as (ImprovementUse & {id:string;revision:number})[];
  if(!pending.length) return;
  const storage=await openDurablePassiveStorage(directory,ctx);
  if(!storage) throw new Error("无法核对交付的原生完成回执");
  try {
    for(const cid of new Set(pending.map(p=>p.conversation))){
      const candidates=pending.filter(p=>p.conversation===cid);
      let cursor:Cursor|undefined;
      do{
        const page=await storage.scanSubmissions({conversationId:Number(cid) as ConversationId},128,cursor,ctx);
        for(const s of page.items){
          if(s.type!=="input" || s.status!=="done" || !s.entry) continue;
          const matches=candidates.filter(p=>p.run===String(s.entry));
          if(!matches.length) continue;
          const answer=(await storage.entry(s.answer,ctx))?.entry;
          if(!answer || String(answer.conversationId)!==cid)continue;
          const final=answer.model?.find(m=>m.role==="assistant" && m.stopReason==="stop");
          if(!final) continue;
          for(const p of matches) if(String(answer.byTaskId)===String(p.generation))
            packages.record(p.id,p.revision,{...p,event:"accepted",detail:String(s.answer),at:final.timestamp});
        }
        cursor=page.next;
      }while(cursor);
    }
  } finally {await storage.close(ctx);}
}
