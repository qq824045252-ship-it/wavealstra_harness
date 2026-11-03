#!/usr/bin/env node
// Read-only analysis of metadata traces. Never requires model credentials or a network call.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarizeCacheTraces(records) {
  const groups = new Map(), sends = new Map();
  const ordered = [...records].sort((a,b)=>String(a.epoch).localeCompare(String(b.epoch)) || (a.sequence ?? a.at) - (b.sequence ?? b.at));
  for (const row of ordered) {
    if (row.version !== 1 || !row.epoch || !row.request) continue;
    const key = `${row.epoch}/${row.request}`;
    const list = groups.get(key) ?? [];list.push(row);groups.set(key,list);
    if (row.event === 'request' && row.stage === 'http') sends.set(`${key}/${row.attempt}`,row);
  }
  const calls=[];
  for (const rows of groups.values()) {
    const result=rows.findLast(r=>r.event==='result');
    if(!result) continue;
    const http=rows.filter(r=>r.event==='request'&&r.stage==='http').sort((a,b)=>a.attempt-b.attempt);
    const first=http[0],last=http.at(-1);
    const before=first?.previous;
    const prior=before?sends.get(`${result.epoch}/${before.request}/${before.attempt}`):undefined;
    const complete=http.length>0&&http.every(r=>r.coverage==='complete');
    const retryChanged=complete&&http.some(r=>r.bodyHash!==first.bodyHash||r.affinityHash!==first.affinityHash||r.endpointHash!==first.endpointHash);
    const routeChanged=prior&&first&&(prior.affinityHash!==first.affinityHash||prior.endpointHash!==first.endpointHash);
    const changed=before&&(before.prefix===false||before.changedFields?.length>0);
    let classification='no-comparable-predecessor';
    if(!complete)classification='missing-http-observation';
    else if(retryChanged)classification='retry-request-changed';
    else if(changed||routeChanged)classification='client-request-changed';
    else if(before&&before.prefix===true){
      classification=!prior?'history-gap':result.hitRate!=null&&result.hitRate<0.5?'stable-prefix-low-cache':'stable-prefix';
    }
    calls.push({at:result.at,epoch:result.epoch,request:result.request,sessionHash:result.sessionHash,
      responseHash:result.responseHash,responseModelHash:result.responseModelHash,classification,hitRate:result.hitRate,usage:result.usage,outcome:result.outcome,
      sends:http.length,httpStatuses:rows.filter(r=>r.event==='http-result').map(r=>r.status),
      inputCount:last?.inputCount,sharedItems:before?.sharedItems,changedFields:before?.changedFields??[],
      firstDifference:before?.firstDifference?{index:before.firstDifference.index,
        oldKind:before.firstDifference.old?.kind,newKind:before.firstDifference.current?.kind,
        fields:before.firstDifference.changedItemFields}:undefined,
      routeChanged:Boolean(routeChanged),retryChanged,
      boundaryChanges:prior&&first?['user','compaction','ledger','reset','operation'].filter(k=>prior.boundary?.[k]!==first.boundary?.[k]):[],
      adapterMatches:http.map(r=>r.adapterMatch??null)});
  }
  calls.sort((a,b)=>a.at-b.at);
  const buckets={};for(const c of calls)buckets[c.classification]=(buckets[c.classification]??0)+1;
  return {calls: calls.length,classificationCounts:buckets,requests:calls,limits:[
    'Stable client HTTP input does not prove stable gateway-to-provider input or upstream cache placement.',
    'A changed request can be intentional (user/compaction/model/tools); a fingerprint is evidence, not fault attribution.',
    'Different process epochs, evicted chains, truncated bodies and rotated-away predecessors are not compared as unchanged.',
    'Only observed HTTP JSON sends have final-body coverage; WebSockets and arbitrary request streams remain explicit gaps.',
  ]};
}

function main(){
  const args=process.argv.slice(2).filter(a=>a!=='--');
  let dir=join(homedir(),'.mybuddy/logs'),session;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--dir'&&args[i+1])dir=resolve(args[++i]);
    else if(args[i]==='--session'&&args[i+1]){const value=args[++i];session=/^[a-f0-9]{64}$/.test(value)?value:createHash('sha256').update(value).digest('hex');}
    else throw Error('Usage: cache:trace [--dir LOG_DIRECTORY] [--session SESSION_ID_OR_HASH]');
  }
  const records=[];
  for(const name of readdirSync(dir).filter(n=>/^cache-requests-\d{8}(?:-\d+)?\.log$/.test(n))){
    for(const line of readFileSync(join(dir,name),'utf8').split('\n')){
      const at=line.indexOf('[cache-trace] ');if(at<0)continue;
      try{const row=JSON.parse(line.slice(at+14));if(!session||row.sessionHash===session)records.push(row)}catch{/* incomplete final line */}
    }
  }
  console.log(JSON.stringify(summarizeCacheTraces(records),null,2));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  try{main()}catch(error){console.error(error.message);process.exitCode=1}
}
