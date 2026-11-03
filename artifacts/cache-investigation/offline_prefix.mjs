import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const { stream } = await import(process.env.PACKAGED_PI === '1' ? '../../release/win-unpacked/resources/app.asar.unpacked/out/main/capabilities/subagent/runtime/chunks/openai-responses-T2ZF6BDC.mjs' : '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js');
import { convertToLlm } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js';
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const home=process.env.USERPROFILE;
const file=path.join(home,'.mybuddy/sessions/--C--Users-servi-Documents-GitHub-wavealstra_harness--/2026-11-02T00-38-27-671Z_01a199b1-7a56-7415-b47b-0cdd635c3fc0.jsonl');
const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
const config=JSON.parse(fs.readFileSync(path.join(home,'.mybuddy/models.json'),'utf8'));
const history=[], prior=new Map(), report=[];
let selected, effort, preventedNetwork=0;
for(let i=0;i<rows.length;i++){
  const r=rows[i];
  if(r.type==='model_change')selected=r.modelId;
  if(r.type==='thinking_level_change')effort=r.thinkingLevel;
  if(r.type!=='message')continue;
  const m=r.message;
  if(m.role==='assistant'){
    const configured=config.providers.magpie.models.find(x=>x.id===selected);
    const model={...configured,provider:'magpie',baseUrl:'http://127.0.0.1:1/v1',api:'openai-responses',id:selected};
    let payload;
    const result=await stream(model,{messages:convertToLlm(history)}, {apiKey:'synthetic-no-network',sessionId:rows[0].id,reasoningEffort:effort,onPayload:p=>{payload=p;throw new Error('OFFLINE_CAPTURE_ONLY');},fetch:()=>{preventedNetwork++;throw new Error('NETWORK_MUST_NOT_RUN');}}).result();
    if(!payload)throw new Error('Could not capture payload: '+result.errorMessage);
    const itemHashes=payload.input.map(hash);
    const previous=prior.get(selected);
    let shared=0;
    if(previous)while(shared<previous.items.length&&shared<itemHashes.length&&previous.items[shared]===itemHashes[shared])shared++;
    const firstMismatch=previous&&shared<previous.items.length?shared:null;
    const baseFields={...payload};delete baseFields.input;
    report.push({line:i+1,model:selected,cacheRead:m.usage?.cacheRead,input:m.usage?.input,payloadInputItems:payload.input.length,payloadChars:JSON.stringify(payload).length,sharedPreviousItems:previous?shared:null,previousItems:previous?.items.length??null,firstMismatch,baseFieldsHash:hash(baseFields),cacheKeyHash:hash(payload.prompt_cache_key??''),reasoning:payload.reasoning,include:payload.include,thinkingBlocks:m.content.filter(b=>b.type==='thinking').map(b=>({signature:!!b.thinkingSignature,signatureFields:b.thinkingSignature?Object.keys(JSON.parse(b.thinkingSignature)):[]}))});
    prior.set(selected,{items:itemHashes});
  }
  history.push(m);
}
const output={scope:'Offline reconstruction of persisted history through installed Pi converter; excludes request-only capsules and gateway transformations',networkCalls:preventedNetwork,rows:report};
fs.writeFileSync(process.env.PACKAGED_PI === '1' ? 'artifacts/cache-investigation/offline-packaged-prefix-evidence.json' : 'artifacts/cache-investigation/offline-prefix-evidence.json',JSON.stringify(output,null,2));
console.log(JSON.stringify({calls:report.length,networkCalls:preventedNetwork,mismatches:report.filter(r=>r.firstMismatch!==null),uniqueBaseHashes:[...new Set(report.map(r=>r.baseFieldsHash))],first:report[0],last:report.at(-1)},null,2));
