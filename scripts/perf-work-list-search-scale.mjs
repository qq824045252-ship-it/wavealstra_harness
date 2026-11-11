/** Run after perf-work-list-search.mjs: protect the small/large query-plan boundary. */
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),out=resolve('out/diagnostics/work-search');
const root=mkdtempSync(join(out,'scale-profile-'));
process.env.HOME=root;process.env.USERPROFILE=root;
const reports=[];
for(const label of ['baseline','candidate']){
  const {fixture}=require(join(out,`${label}.cjs`)),results=[];
  for(const n of [1,100,999,1000,10000]){
    const f=fixture(join(root,`${label}-${n}.db`),n);
    try{
      for(const [name,query] of [['title-all','Synthetic'],['title-rare',`Synthetic ${n-1}`],['no-match','NoSuchTerm_测试']]){
        const samples=[];let digest;
        for(let i=0;i<8;i++){
          const start=performance.now(),result=f.db.transaction(()=>f.read({scope:{kind:'all'},view:'all',query}))();samples.push(performance.now()-start);
          const{watermark,...payload}=result,hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
          if(digest)assert.equal(hash,digest,`${n}/${name} stable output`);digest=hash;
        }
        const firstQueryMs=samples.shift();samples.sort((a,b)=>a-b);
        results.push({n,name,firstQueryMs,medianMs:samples[3],digest});
      }
    }finally{f.app.close();}
  }
  reports.push({label,results});
}
const comparison=reports[0].results.map((before,i)=>{
  const after=reports[1].results[i];assert.equal(before.digest,after.digest,`${before.n}/${before.name} exact parity`);
  return {n:before.n,name:before.name,firstBeforeMs:before.firstQueryMs,firstAfterMs:after.firstQueryMs,
    medianBeforeMs:before.medianMs,medianAfterMs:after.medianMs,exactParity:true};
});
writeFileSync(join(out,'scale-comparison.json'),JSON.stringify({samplesPerCase:8,comparison},null,2));
console.log(JSON.stringify(comparison,null,2));
