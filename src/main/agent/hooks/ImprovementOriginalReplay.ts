import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryId } from "@earendil-works/pi-durable";
import { durableRegisteredArtifact } from "../durable/DurableArtifactRegistration";
import { DurableSubagentIdentity } from "../durable/DurableSubagentIdentity";
import { openDurablePassiveStorage } from "../durable/DurableStorage";
import { messageText } from "./ImprovementDecisions";
import { deliveryCorrection, verifyDeliveryContract } from "./DeliveryContract";
import type { ReleaseDraft } from "./ImprovementPackages";

export class UnverifiedOriginalDelivery extends Error {}

/** Replay the immutable output that existed before the user corrected the assistant. */
export async function replayOriginalDelivery(directory: string,draft:ReleaseDraft,target:string) {
  const {source,contract}=draft;
  const storage=await openDurablePassiveStorage(directory,ctx);
  if(!storage)throw new UnverifiedOriginalDelivery("原始产物记录已不可用");
  try {
    const actor=Number(source.conversationId) as ConversationId;
    let owner=actor;
    const chain=new Set<number>();
    for(;;){
      if(chain.has(owner))throw new Error("原生会话归属无效");
      chain.add(owner);
      const c=await storage.conversation(owner,ctx);
      if(!c)throw new UnverifiedOriginalDelivery("原始会话不存在");
      if(!c.owner)break;
      owner=c.owner.conversationId;
    }
    const correction=(await storage.entry(source.entry as EntryId,ctx))?.entry;
    const user=correction?.model?.find(m=>m.role==="user");
    const input=(correction?.data as {mybuddyInput?:{text?:string}}|undefined)?.mybuddyInput?.text;
    const text=input ?? (user?messageText(user.content):"");
    if(correction?.conversationId!==actor || !deliveryCorrection(text,contract)) throw new UnverifiedOriginalDelivery("无法核实原始用户纠正");
    let inputIds:number[]=[];
    if(owner===actor) {
      let next:Cursor|undefined;
      do {
        const page=await storage.scanSubmissions({conversationId:actor},128,next,ctx);
        inputIds.push(...page.items.filter(s=>s.type==="input" && s.entry===source.input).map(s=>s.id));
        next=page.next;
      }while(next&&!inputIds.length);
    }else{
      const identity=await storage.findDocument({kind:DurableSubagentIdentity.definition.kind,scope:{kind:"conversation",conversationId:actor}},"current",ctx);
      const child=identity && (await storage.document(identity.id,"current",ctx))?.value?.value as {value?:{taskId?:string;parentSubmissionIds?:number[]}}|undefined;
      if(child?.value?.taskId===source.taskId)inputIds=child.value.parentSubmissionIds??[];
    }
    if(!inputIds.length)throw new UnverifiedOriginalDelivery("原始交付缺少可核实的原生提交");
    const paths=[contract.document,...contract.attachments];
    const captured=new Set<string>();
    const expectedEvidence:Record<string,string>={};
    let cursor:Cursor|undefined;
    do{
      const page=await storage.scanEntries({conversationId:owner,minEntryId:source.input as EntryId,maxEntryId:source.trigger as EntryId,order:"descending"},128,cursor,ctx);
      for(const e of page.items){
        if(e.kind!=="mybuddy.artifact-registered")continue;
        const inputId=inputIds.find(id=>(e.data as {inputIds?:number[]}).inputIds?.includes(id));
        if(inputId===undefined)continue;
        const artifact=durableRegisteredArtifact(e,inputId,undefined,directory);
        if(!artifact)continue;
        let executor=artifact.toolConversationId as ConversationId;
        const visited=new Set<number>();
        while(executor!==actor && !visited.has(executor)){
          visited.add(executor);
          const c=await storage.conversation(executor,ctx);
          if(!c?.owner) break;
          // A nested tool may write for this actor. An independent delegated agent may not.
          if(await storage.findDocument({kind:"mybuddy.subagent",scope:{kind:"conversation",conversationId:executor}},"current",ctx)) break;
          executor=c.owner.conversationId;
        }
        if(executor!==actor)continue;
        const path=paths.find(p=>resolve(artifact.cwd,p)===artifact.path);
        if(!path || captured.has(path))continue;
        const stat=await lstat(artifact.snapshotPath);
        if(!stat.isFile() || stat.size>4*1024*1024 || stat.size!==artifact.sizeBytes) throw new UnverifiedOriginalDelivery("原始产物快照不可验证");
        const bytes=await readFile(artifact.snapshotPath);
        if(createHash("sha256").update(bytes).digest("hex")!==artifact.digest)throw new UnverifiedOriginalDelivery("原始产物快照指纹变化");
        await mkdir(dirname(join(target,path)),{recursive:true});
        await writeFile(join(target,path),bytes,{flag:"wx"});
        captured.add(path);
        expectedEvidence[path]=artifact.digest;
      }
      cursor=page.next;
    }while(cursor);
    if(!captured.has(contract.document))throw new UnverifiedOriginalDelivery("未取得本轮该代理的原始文档版本");
    const observed=await verifyDeliveryContract(target,contract);
    if(observed.status!=="missing" || !observed.missing.some(item=>text.includes(item.replace(/^标题: /,""))))throw new UnverifiedOriginalDelivery("原始交付快照未复现用户指出的缺项");
    return {...observed,expectedEvidence};
  }finally{await storage.close(ctx);}
}
