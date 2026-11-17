import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synchronize, syncSnapshot, readSnapshot, viewEvents } from '../examples/gadgets/calendar-sync/server/calendar.mjs';

const event=(id,date,status='confirmed')=>({id,summary:id,start:{date},end:{date:'2026-11-02'},status});
const old=[event('海关','2026-10-26'),event('治理','2026-10-27'),event('商标','2026-11-01')];
const queries=[];
const full=await synchronize(async params=>{
  queries.push(params);
  return params.pageToken?{items:[old[2]],nextSyncToken:'token-a'}:{items:old.slice(0,2),nextPageToken:'second'};
},null);
assert.deepEqual(full.events.map(e=>e.id),['海关','治理','商标']);
assert.equal(full.report.pages,2);
for(const query of queries){assert.equal(query.timeMin,undefined);assert.equal(query.timeMax,undefined);assert.equal(query.orderBy,undefined);assert.equal(query.singleEvents,false);}
const delta=await synchronize(async params=>{
  assert.equal(params.syncToken,'token-a');
  return {items:[event('海关','2026-10-26','cancelled'),{...old[1],summary:'治理已更新'}],nextSyncToken:'token-b'};
},full.calendar);
assert.deepEqual(delta.events.map(e=>e.summary),['治理已更新','商标']);
assert.equal(delta.calendar.syncToken,'token-b');
let requests=0;
const expired=await synchronize(async params=>{
  requests++;
  if(params.syncToken)throw Object.assign(new Error('expired'),{status:410});
  return {items:[old[2]],nextSyncToken:'new-full'};
},delta.calendar);
assert.equal(requests,2);assert.equal(expired.report.mode,'full-after-expiry');assert.deepEqual(expired.events.map(e=>e.id),['商标']);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'calendar-sync-'));
const sourcePath=path.join(root,'code'),dataPath=path.join(root,'data');fs.mkdirSync(sourcePath);fs.mkdirSync(dataPath);
fs.writeFileSync(path.join(sourcePath,'data.json'),JSON.stringify({events:[],tasks:[{id:'keep-task'}],notes:[{id:'keep-note'}]}));
try {
  await syncSnapshot({sourcePath,dataPath,request:async()=>({items:old,nextSyncToken:'safe-token'})});
  const before=fs.readFileSync(path.join(dataPath,'calendar-sync.json'),'utf8');
  await assert.rejects(syncSnapshot({sourcePath,dataPath,request:async params=>{if(params.pageToken)throw Error('second page unavailable');return {items:[event('new','2026-11-01')],nextPageToken:'failed-page'};}}));
  assert.equal(fs.readFileSync(path.join(dataPath,'calendar-sync.json'),'utf8'),before);
  const snapshot=readSnapshot(sourcePath,dataPath);assert.equal(snapshot.events.length,3);assert.deepEqual(snapshot.tasks,[{id:'keep-task'}]);assert.deepEqual(snapshot.notes,[{id:'keep-note'}]);assert(snapshot.calendarSync.error);
  await syncSnapshot({sourcePath,dataPath,request:async()=>({items:[],nextSyncToken:'after-empty-delta'})});
  assert.equal(readSnapshot(sourcePath,dataPath).events.length,3);assert.equal(readSnapshot(sourcePath,dataPath).calendarSync.error,undefined);
  let releaseRequest;
  const waiting=new Promise(resolve=>{releaseRequest=resolve;});
  const inFlight=syncSnapshot({sourcePath,dataPath,request:()=>waiting});
  await assert.rejects(syncSnapshot({sourcePath,dataPath,request:()=>{throw Error('concurrent request must not run');}}),error=>error.code==='SYNC_BUSY');
  assert.equal(readSnapshot(sourcePath,dataPath).events.length,3);
  releaseRequest({items:[],nextSyncToken:'after-concurrent-attempt'});await inFlight;
  assert.equal(fs.existsSync(path.join(dataPath,'calendar-sync.lock')),false);
  const controller=new AbortController();controller.abort();
  const beforeAbort=fs.readFileSync(path.join(dataPath,'calendar-sync.json'),'utf8');
  await assert.rejects(syncSnapshot({sourcePath,dataPath,signal:controller.signal,request:()=>{throw Error('aborted request must not run');}}));
  assert.equal(fs.readFileSync(path.join(dataPath,'calendar-sync.json'),'utf8'),beforeAbort);
  assert.equal(fs.existsSync(path.join(dataPath,'calendar-sync.lock')),false);
  const recurrent={events:[{id:'series',recurrence:['RRULE:FREQ=DAILY']}]};
  const view=await viewEvents(async params=>{assert.equal(params.timeMin,'2026-10-26T00:00:00+08:00');assert.equal(params.timeMax,'2026-11-02T00:00:00+08:00');return {items:[old[0]]};},recurrent,'2026-10-26','2026-11-01');
  assert.equal(view.length,1);assert.equal(recurrent.events.length,1);
  await assert.rejects(viewEvents(()=>{throw Error('must not query')},recurrent,'2026-10-26','2027-01-01'));
  console.log('PASS historical backfill, pagination, ID merge/delete, token expiry, atomic failure retention, empty delta retention, concurrent exclusion, abort cleanup, independent display queries');
} finally{fs.rmSync(root,{recursive:true,force:true});}
