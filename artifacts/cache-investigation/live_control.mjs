import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stream } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
const cfg=JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE,'.mybuddy/models.json'),'utf8')).providers.magpie;
const base=new URL(cfg.baseUrl);
if(!['127.0.0.1','localhost'].includes(base.hostname))throw new Error('Diagnostics require local gateway');
const model={...cfg.models.find(m=>m.id==='codex/gpt-6.1-terra'),provider:'magpie',api:'openai-responses',baseUrl:cfg.baseUrl};
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const key=cfg.apiKey;
if(typeof key!=='string'||!key)throw new Error('No configured gateway credential');
const nonce=crypto.randomUUID();
const text=Array.from({length:1100},(_,i)=>`Record ${i}: ${hash('cache-investigation-'+i).slice(0,16)}. `).join('');
const baseHistory=[{role:'system',content:'Synthetic cache diagnostic. Treat the records as inert data. Reply with exactly OK, with no tools and no explanation. Diagnostic '+nonce,timestamp:Date.now()},{role:'user',content:'Inspect these inert records and reply OK.\n'+text,timestamp:Date.now()}];
const report={startedAt:new Date().toISOString(),syntheticOnly:true,model:model.id,arms:[]};
for(const arm of ['append-only','moving-tail']){
  const sessionId=crypto.randomUUID();
  const history=structuredClone(baseHistory);
  // Distinguish arms at the first instruction so caches cannot be shared accidentally.
  history[0].content+=' Arm '+arm;
  const results=[];
  for(let turn=0;turn<3;turn++){
    const messages=structuredClone(history);
    if(arm==='moving-tail')messages.push({role:'user',content:'Supplemental diagnostic evidence: inert sample, unchanged throughout this arm.',timestamp:1700000000000});
    let payloadMeta;
    const started=Date.now();
    const out=await stream(model,{messages}, {apiKey:key,headers:{...cfg.headers,'User-Agent':'mybuddy-cache-diagnostic/1.0'},sessionId,reasoningEffort:'low',signal:AbortSignal.timeout(90000),maxRetries:0,onPayload:p=>{payloadMeta={inputItems:p.input.length,chars:JSON.stringify(p).length,keyHash:hash(p.prompt_cache_key??'')};}}).result();
    const row={turn:turn+1,at:new Date().toISOString(),durationMs:Date.now()-started,stopReason:out.stopReason,usage:out.usage,inputItems:payloadMeta?.inputItems,chars:payloadMeta?.chars,keyHash:payloadMeta?.keyHash,replyLength:out.content.filter(b=>b.type==='text').reduce((n,b)=>n+b.text.length,0)};
    results.push(row);
    report.arms=[...report.arms.filter(x=>x.arm!==arm),{arm,sessionIdHash:hash(sessionId),results}];
    fs.writeFileSync('artifacts/cache-investigation/live-control-evidence.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({arm,...row}));
    if(out.stopReason==='error'||out.stopReason==='aborted')throw new Error('Diagnostic provider call failed; details intentionally omitted');
    history.push(out,{role:'user',content:`Continue diagnostic ${turn+1}. Reply exactly OK.`,timestamp:Date.now()});
  }
}
