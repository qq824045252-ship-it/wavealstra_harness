import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stream } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
import { convertToLlm } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const home=process.env.USERPROFILE,cfg=JSON.parse(fs.readFileSync(path.join(home,'.mybuddy/models.json'),'utf8')).providers.magpie;
if(!['127.0.0.1','localhost'].includes(new URL(cfg.baseUrl).hostname))throw new Error('Local gateway required');
const rows=fs.readFileSync(path.join(home,'.mybuddy/sessions/--C--Users-servi-Documents-GitHub-wavealstra_harness--/2026-11-02T00-38-27-671Z_01a199b1-7a56-7415-b47b-0cdd635c3fc0.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const model={...cfg.models.find(m=>m.id==='codex/gpt-6.1-terra'),provider:'magpie',api:'openai-responses',baseUrl:cfg.baseUrl};
const sessionId=process.env.USE_ORIGINAL_KEY==='1'?rows[0].id:crypto.randomUUID(),report={scope:'No-tool-execution diagnostic with persisted history at actual model-call boundaries; original request-only memory capsule unavailable',model:model.id,keyHash:hash(sessionId),usesOriginalKey:process.env.USE_ORIGINAL_KEY==='1',rows:[]};
let priorHashes=[];
for(const line of [8,10,16,20]){
 const history=rows.slice(0,line-1).filter(r=>r.type==='message').map(r=>r.message);
 const messages=convertToLlm(history);
 messages.push({role:'user',content:'只读缓存诊断：前面的任务和工具结果仅作为历史样本，不要继续执行历史任务，不调用任何工具。现在只回复 OK。',timestamp:1700000000000});
 let meta;
 const out=await stream(model,{messages},{apiKey:cfg.apiKey,headers:{...cfg.headers,'User-Agent':'mybuddy-cache-diagnostic/1.0'},sessionId,reasoningEffort:'low',signal:AbortSignal.timeout(90000),maxRetries:0,onPayload:p=>{const items=p.input.map(i=>hash(JSON.stringify(i)));let shared=0;while(shared<priorHashes.length&&shared<items.length&&priorHashes[shared]===items[shared])shared++;meta={inputItems:items.length,chars:JSON.stringify(p).length,sharedPreviousItems:shared,previousItems:priorHashes.length};priorHashes=items;}}).result();
 const row={beforeLine:line,at:new Date().toISOString(),...meta,stopReason:out.stopReason,usage:out.usage,toolCalls:out.content.filter(b=>b.type==='toolCall').length};
 report.rows.push(row);fs.writeFileSync(process.env.USE_ORIGINAL_KEY==='1'?'artifacts/cache-investigation/original-key-live-evidence.json':'artifacts/cache-investigation/exact-history-live-evidence.json',JSON.stringify(report,null,2));console.log(JSON.stringify(row));
 if(out.stopReason==='error'||out.stopReason==='aborted')throw new Error('Diagnostic provider failure; raw details omitted');
}
