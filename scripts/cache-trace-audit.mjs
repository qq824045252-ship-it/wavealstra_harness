#!/usr/bin/env node
// Read-only analysis of metadata traces. Never requires model credentials or a network call.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tokenCount = value => Number.isSafeInteger(value) && value >= 0;
const requestFailed = (result, raw) => ['error', 'aborted', 'observation-failed'].includes(result?.outcome)
  || raw?.terminal === 'response.failed' || ['failed', 'cancelled'].includes(raw?.responseStatus);

function rawUsageEvidence(raw) {
  const input = raw?.usage?.inputTokens, cached = raw?.usage?.cachedTokens;
  const inputTokenState = input == null ? 'missing' : tokenCount(input) ? 'valid' : 'invalid';
  const cacheReadState = !raw?.cachedTokensPresent ? 'missing'
    : !tokenCount(cached) || (inputTokenState === 'valid' && cached > input) ? 'invalid'
    : cached === 0 ? 'explicit-zero' : 'positive';
  const rawUsageState = inputTokenState === 'invalid' || cacheReadState === 'invalid' ? 'invalid'
    : inputTokenState === 'missing' || cacheReadState === 'missing' ? 'missing' : 'complete';
  return { inputTokenState, cacheReadState, rawUsageState };
}

// A normalized zero may mean the provider did not report usage. Only a successful
// predecessor's valid raw prompt count can support a cache-reuse estimate.
function predecessorUsage(result, raw) {
  if (!result) return { previousUsageState: 'missing-result', previousPromptTokens: null };
  if (requestFailed(result, raw)) return { previousUsageState: 'request-failed', previousPromptTokens: null };
  if (!['stop', 'length', 'toolUse'].includes(result.outcome)
    || !['response.completed', 'response.incomplete'].includes(raw?.terminal)) {
    return { previousUsageState: 'unobserved-success', previousPromptTokens: null };
  }
  const evidence = rawUsageEvidence(raw);
  const previousUsageState = evidence.inputTokenState !== 'valid' ? `raw-input-${evidence.inputTokenState}`
    : evidence.cacheReadState === 'invalid' ? 'raw-cache-invalid' : 'available';
  return { previousUsageState, previousPromptTokens: previousUsageState === 'available' ? raw.usage.inputTokens : null };
}

const compareHashes = (a, b, keys) => {
  if (!a || !b) return null;
  const known = keys.filter(key => typeof a[key] === 'string' && typeof b[key] === 'string');
  if (known.some(key => a[key] !== b[key])) return true;
  return known.length === keys.length ? false : null;
};

export function summarizeCacheTraces(records) {
  const groups = new Map(), sends = new Map(), results = new Map(), rawUsages = new Map();
  const ordered = [...records].sort((a,b)=>String(a.epoch).localeCompare(String(b.epoch)) || (a.sequence ?? a.at) - (b.sequence ?? b.at));
  for (const row of ordered) {
    if (row.version !== 1 || !row.epoch || !row.request) continue;
    const key = `${row.epoch}/${row.request}`;
    const list = groups.get(key) ?? [];list.push(row);groups.set(key,list);
    if (row.event === 'request' && row.stage === 'http') sends.set(`${key}/${row.attempt}`,row);
    if (row.event === 'result') results.set(key,row);
    if (row.event === 'provider-usage') rawUsages.set(key,row);
  }
  const calls=[];
  for (const rows of groups.values()) {
    const result=rows.findLast(r=>r.event==='result');
    if(!result) continue;
    const http=rows.filter(r=>r.event==='request'&&r.stage==='http').sort((a,b)=>a.attempt-b.attempt);
    const first=http[0],last=http.at(-1);
    const before=first?.previous;
    const prior=before?sends.get(`${result.epoch}/${before.request}/${before.attempt}`):undefined;
    const priorKey=before?`${result.epoch}/${before.request}`:undefined;
    const {previousUsageState,previousPromptTokens}=predecessorUsage(results.get(priorKey),rawUsages.get(priorKey));
    const raw=rows.findLast(r=>r.event==='provider-usage');
    const rawUsage=raw ? { terminal:raw.terminal,responseStatus:raw.responseStatus,coverage:raw.coverage,
      usagePresent:raw.usagePresent,cachedTokensPresent:raw.cachedTokensPresent,usage:raw.usage } : null;
    const {cacheReadState,inputTokenState,rawUsageState}=rawUsageEvidence(raw);
    const measured=rawUsageState==='complete';
    const failed=requestFailed(result,raw);
    const rawHitRate=measured&&raw.usage.inputTokens>0?raw.usage.cachedTokens/raw.usage.inputTokens:null;
    const historyUncachedTokens=!failed&&measured&&previousPromptTokens>0?Math.max(0,previousPromptTokens-raw.usage.cachedTokens):null;
    const complete=http.length>0&&http.every(r=>r.coverage==='complete');
    const retryChanged=complete&&http.some(r=>r.bodyHash!==first.bodyHash||compareHashes(r,first,['affinityHash','endpointHash'])===true);
    const routeChanged=compareHashes(prior,first,['affinityHash','endpointHash']);
    const headersChanged=compareHashes(prior,first,['headersHash']);
    const retryHeaders=http.slice(1).map(r=>compareHashes(r,first,['headersHash']));
    const retryHeadersChanged=retryHeaders.includes(true)?true:retryHeaders.includes(null)?null:retryHeaders.length?false:null;
    const changed=before&&(before.prefix===false||before.changedFields?.length>0);
    let classification='no-comparable-predecessor';
    if(!complete)classification='missing-http-observation';
    else if(retryChanged)classification='retry-request-changed';
    else if(changed||routeChanged)classification='client-request-changed';
    else if(before&&before.prefix===true){
      const partial=historyUncachedTokens!=null&&historyUncachedTokens>Math.max(512,(previousPromptTokens??0)*0.08);
      classification=!prior?'history-gap':previousPromptTokens===null?'predecessor-usage-unavailable':partial?
        rawHitRate!=null&&rawHitRate<0.5?'stable-prefix-low-cache':'stable-prefix-partial-cache':
        previousPromptTokens>0&&rawHitRate!=null&&rawHitRate<0.5?'stable-prefix-new-input':'stable-prefix';
    }
    const requestClassification=classification;
    if(failed)classification='request-failed';
    else if(rawUsageState==='missing')classification='raw-cache-usage-missing';
    else if(rawUsageState==='invalid')classification='raw-cache-usage-invalid';
    calls.push({at:result.at,epoch:result.epoch,request:result.request,sessionHash:result.sessionHash,
      source:result.source??'main',parentSessionHash:result.parentSessionHash,
      responseHash:result.responseHash,responseModelHash:result.responseModelHash,classification,requestClassification,
      hitRate:result.hitRate,usage:result.usage,outcome:result.outcome,rawUsage,cacheReadState,inputTokenState,rawUsageState,rawHitRate,
      normalizedCacheReadMatches:measured&&tokenCount(result.usage?.cacheRead)?result.usage.cacheRead===raw.usage.cachedTokens:null,
      previousPromptTokens,previousUsageState,historyUncachedTokens,
      sends:http.length,httpStatuses:rows.filter(r=>r.event==='http-result').map(r=>r.status),
      inputCount:last?.inputCount,sharedItems:before?.sharedItems,changedFields:before?.changedFields??[],
      firstDifference:before?.firstDifference?{index:before.firstDifference.index,
        oldKind:before.firstDifference.old?.kind,newKind:before.firstDifference.current?.kind,
        fields:before.firstDifference.changedItemFields}:undefined,
      routeChanged,retryChanged,headersChanged,retryHeadersChanged,headersScope:last?.headersScope??null,
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
    'Header hashes cover SDK fetch arguments only, not automatic HTTP headers or WebSocket frames; null means unobserved, not empty.',
    'Missing raw cache usage is unknown, not zero. Normalized usage and hitRate are retained unchanged; rawHitRate uses provider counts.',
    'Raw input/cache counts must be non-negative safe integers and cached tokens cannot exceed input tokens; invalid or missing counts do not produce cache estimates.',
    'A failed, unobserved or invalidly metered predecessor cannot establish reusable prompt size; predecessor-usage-unavailable preserves that uncertainty.',
    'All-header changes can be SDK retry bookkeeping; only the fixed affinity subset and endpoint contribute to routeChanged.',
    'historyUncachedTokens compares the preceding prompt size with current cache reads; it is a diagnostic estimate, not proven waste or billable savings.',
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
      try{const row=JSON.parse(line.slice(at+14));if(!session||row.sessionHash===session||row.parentSessionHash===session)records.push(row)}catch{/* incomplete final line */}
    }
  }
  console.log(JSON.stringify(summarizeCacheTraces(records),null,2));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  try{main()}catch(error){console.error(error.message);process.exitCode=1}
}
