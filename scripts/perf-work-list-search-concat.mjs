/** Interleaved full-API A/B for report size growth; no private profile or product build. */
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),out=resolve('out/diagnostics/work-search-concat');mkdirSync(out,{recursive:true});
const baseline=process.argv[2]||'9f93c0263c28a443e5ed9964f4cecd7c0cb3586e';
const path='src/main/agent/work/WorkListQuery.ts',before=execFileSync('git',['show',baseline+':'+path],{encoding:'utf8'}),after=readFileSync(path,'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
for(const [label,source] of Object.entries({baseline:before,candidate:after}))
  await build({stdin:{contents:`export {fixture} from './scripts/perf-work-list-search'; export {WorkListQuery} from './src/main/agent/work/WorkListQuery'; export {LOCAL_USER_ID} from './src/shared/bot-work';`,loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',packages:'external',outfile:join(out,label+'.cjs'),plugins:[{name:'variant',setup(b){b.onLoad({filter:/[/\\]WorkListQuery\.ts$/},a=>({contents:source,loader:'ts',resolveDir:dirname(a.path)}));}}]});
const home=mkdtempSync(join(tmpdir(),'work-concat-'));process.env.HOME=home;process.env.USERPROFILE=home;
const {fixture,LOCAL_USER_ID}=require(join(out,'baseline.cjs')),f=fixture(join(home,'fixture.db'));
const instances=Object.fromEntries(['baseline','candidate'].map(label=>[label,new (require(join(out,label+'.cjs')).WorkListQuery)(f.db)]));
const results=[];
try{
  for(const repeats of [1000,6000,30000]){
    const report='Long report content. '.repeat(repeats)+'DeepReportTail';
    f.db.prepare('UPDATE work_deliverables SET summary=?').run(report);
    for(const term of ['DeepReportTail','NoSuchTerm_测试','Synthetic 49999']){
      const samples={baseline:[],candidate:[]},first={};let reference;
      for(let round=0;round<6;round++)for(const label of (round%2?['candidate','baseline']:['baseline','candidate'])){
        const t=performance.now(),value=f.db.transaction(()=>instances[label].query(LOCAL_USER_ID,{scope:{kind:'all'},view:'all',query:term}))();
        const ms=performance.now()-t,{watermark,...payload}=value,digest=hash(JSON.stringify(payload));
        assert.equal(value.filtered,term==='DeepReportTail'?250:term==='Synthetic 49999'?1:0);
        reference??=digest;assert.equal(digest,reference,'exact response parity');
        if(round)samples[label].push(ms);else first[label]=ms;
      }
      const row={reportBytes:Buffer.byteLength(report),term,first,samples,medians:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,v.toSorted((a,b)=>a-b)[2]])),digest:reference,exactParity:true};results.push(row);console.log(JSON.stringify(row));
    }
  }
  writeFileSync(join(out,'comparison.json'),JSON.stringify({baseline,sourceHashes:{baseline:hash(before),candidate:hash(after)},node:process.version,sqlite:f.db.prepare('SELECT sqlite_version() AS version').get().version,fixtureRows:50000,reportRows:250,samplesPerCase:5,method:'Interleaved alternating order, same database; result cache bypassed; prepared plans/SQLite/OS caches warm; first invocation separate, not process-cold.',results},null,2));
}finally{f.app.close();rmSync(home,{recursive:true,force:true});}
