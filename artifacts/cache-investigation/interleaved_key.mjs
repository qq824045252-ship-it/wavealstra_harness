import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {stream} from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
import {convertToLlm} from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');const home=process.env.USERPROFILE;
const cfg=JSON.parse(fs.readFileSync(path.join(home,'.mybuddy/models.json'),'utf8')).providers.magpie;
if(!['127.0.0.1','localhost'].includes(new URL(cfg.baseUrl).hostname))throw new Error('Local gateway only');
const rows=fs.readFileSync(path.join(home,'.mybuddy/sessions/--C--Users-servi-Documents-GitHub-wavealstra_harness--/2026-11-02T00-38-27-671Z_01a199b1-7a56-7415-b47b-0cdd635c3fc0.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const model={...cfg.models.find(m=>m.id==='codex/gpt-6.1-terra'),provider:'magpie',api:'openai-responses',baseUrl:cfg.baseUrl};
const original=rows[0].id,newKey=crypto.randomUUID(),v7=(BigInt(Date.now()).toString(16).padStart(12,'0')+crypto.randomBytes(10).toString('hex')).split('');v7[12]='7';v7[16]='8';const v7s=v7.join('');const v7key=`${v7s.slice(0,8)}-${v7s.slice(8,12)}-${v7s.slice(12,16)}-${v7s.slice(16,20)}-${v7s.slice(20,32)}`;
const keys={original,freshV4:newKey,freshV7:v7key,resetSuffix:original+'-cache-reset-1'};
const messages=convertToLlm(rows.slice(0,19).filter(r=>r.type==='message').map(r=>r.message));messages.push({role:'user',content:'只读缓存诊断：前面的任务和工具结果仅作为历史样本，不要继续执行历史任务，不调用任何工具。现在只回复 OK。',timestamp:1700000000000});
const report={scope:'Identical persisted-history content, interleaved cache keys, no tool execution',model:model.id,rows:[]};let inputHash;
for(const arm of ['original','freshV4','original','freshV7','original','resetSuffix','original']){
 let meta;
 const out=await stream(model,{messages:structuredClone(messages)},{apiKey:cfg.apiKey,headers:{...cfg.headers,'User-Agent':'mybuddy-cache-diagnostic/1.0'},sessionId:keys[arm],reasoningEffort:'low',signal:AbortSignal.timeout(90000),maxRetries:0,onPayload:p=>{const withoutKey={...p};delete withoutKey.prompt_cache_key;const h=hash(JSON.stringify(withoutKey));if(inputHash&&inputHash!==h)throw new Error('Content changed unexpectedly');inputHash=h;meta={contentHash:h,keyHash:hash(p.prompt_cache_key??'')};}}).result();
 const row={arm,at:new Date().toISOString(),...meta,stopReason:out.stopReason,usage:out.usage,toolCalls:out.content.filter(b=>b.type==='toolCall').length};report.rows.push(row);fs.writeFileSync('artifacts/cache-investigation/interleaved-key-evidence.json',JSON.stringify(report,null,2));console.log(JSON.stringify(row));if(out.stopReason==='error'||out.stopReason==='aborted')throw new Error('Diagnostic provider failure');
}
