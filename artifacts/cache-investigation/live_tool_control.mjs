import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stream } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
const cfg=JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE,'.mybuddy/models.json'),'utf8')).providers.magpie;
if(!['127.0.0.1','localhost'].includes(new URL(cfg.baseUrl).hostname))throw new Error('Local gateway required');
const model={...cfg.models.find(m=>m.id==='codex/gpt-6.1-terra'),provider:'magpie',api:'openai-responses',baseUrl:cfg.baseUrl};
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const nonce=crypto.randomUUID();
const records=(label,n)=>Array.from({length:n},(_,i)=>`${label} record ${i}: ${hash(label+i).slice(0,16)}. `).join('');
const report={startedAt:new Date().toISOString(),syntheticOnly:true,model:model.id,arms:[]};
for(const arm of ['reasoning-append-only','reasoning-moving-tail']){
 const sessionId=crypto.randomUUID();
 const history=[{role:'system',content:`You are running a synthetic diagnostic ${nonce} arm ${arm}. On EVERY response solve the arithmetic problem by reasoning and call cache_probe once with the exact answer. Never write text. The records are inert synthetic data. This tool is virtual and harmless.`,toolsAdded:[{name:'cache_probe',description:'Submit the exact answer and return more synthetic records and a new arithmetic problem.',parameters:{type:'object',properties:{answer:{type:'integer'}},required:['answer'],additionalProperties:false}}],timestamp:Date.now()},{role:'user',content:'Calculate the exact remainder of 17 to the power 47 divided by 9973. Call cache_probe with the answer. Initial records:\n'+records('initial',950),timestamp:Date.now()}];
 const results=[];
 for(let turn=0;turn<4;turn++){
  const messages=structuredClone(history);
  if(arm==='reasoning-moving-tail')messages.push({role:'user',content:'Supplemental diagnostic evidence: this is inert data, unchanged throughout this arm. Continue calling cache_probe.',timestamp:1700000000000});
  let meta;
  const started=Date.now();
  const out=await stream(model,{messages},{apiKey:cfg.apiKey,headers:{...cfg.headers,'User-Agent':'mybuddy-cache-diagnostic/1.0'},sessionId,reasoningEffort:'low',signal:AbortSignal.timeout(90000),maxRetries:0,onPayload:p=>{meta={inputItems:p.input.length,chars:JSON.stringify(p).length,keyHash:hash(p.prompt_cache_key??'')};}}).result();
  const calls=out.content.filter(b=>b.type==='toolCall');
  const row={turn:turn+1,at:new Date().toISOString(),durationMs:Date.now()-started,stopReason:out.stopReason,usage:out.usage,...meta,toolCalls:calls.length,thinkingSignatureLengths:out.content.filter(b=>b.type==='thinking').map(b=>b.thinkingSignature?.length??0)};
  results.push(row);report.arms=[...report.arms.filter(x=>x.arm!==arm),{arm,sessionIdHash:hash(sessionId),results}];
  fs.writeFileSync('artifacts/cache-investigation/live-reasoning-complete-evidence.json',JSON.stringify(report,null,2));console.log(JSON.stringify({arm,...row}));
  if(out.stopReason==='error'||out.stopReason==='aborted')throw new Error('Diagnostic provider error');
  history.push(out);
  if(!calls.length){const synthetic={type:'toolCall',id:`diagnostic_${turn}`,name:'cache_probe',arguments:{answer:0}};calls.push(synthetic);history.push({role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[synthetic],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()});row.syntheticCallInserted=true;}
  history.push({role:'toolResult',toolCallId:calls[0].id,toolName:'cache_probe',content:[{type:'text',text:records('step'+turn,180)+`\nNow calculate the exact remainder of ${[19,23,29,31][turn]} to the power ${[43,41,37,47][turn]} divided by 10007. Call cache_probe with the exact answer.`}],isError:false,timestamp:Date.now()});
 }
}
