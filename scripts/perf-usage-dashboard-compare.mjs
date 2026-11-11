/** Compare all fields and every case, not only a subset or scalar summaries. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const out=resolve('out/diagnostics/usage-dashboard');
const read=name=>JSON.parse(readFileSync(join(out,name+'.json'),'utf8'));
const rows=[];
for(const n of [10000,100000,300000]){
 const baseline=read(`${n===300000?'baseline-large':'baseline'}-${n}`), candidate=read(`candidate-${n}`), reverse=read(`baseline-reverse-${n}`);
 assert.equal(candidate.results.length,4);assert.equal(reverse.results.length,4);
 for(let i=0;i<4;i++){
  const b=baseline.results[i],c=candidate.results[i],r=reverse.results[i];
  assert.equal(c.label,b.label);assert.equal(c.rangeDays,b.rangeDays);assert.equal(c.label,r.label);assert.equal(c.rangeDays,r.rangeDays);
  assert.equal(c.digest,b.digest);assert.equal(c.digest,r.digest);assert.deepStrictEqual(c.dto,r.dto,`${n}/${c.label}/${c.rangeDays} complete DTO`);
  rows.push({n,label:c.label,rangeDays:c.rangeDays,completeDtoExactEqual:true,digest:c.digest,baseline:b.warm,candidate:c.warm,reverseBaseline:r.warm,wallP50ChangePercent:100*(c.warm.wallMs.p50/b.warm.wallMs.p50-1),candidateVsReversePercent:100*(c.warm.wallMs.p50/r.warm.wallMs.p50-1)});
 }
}
const report={casesCompared:rows.length,notes:['Baseline then candidate then frozen-baseline reverse order, serial. Original and candidate have 5 plain warm samples; reverse has one plain warm sample plus first invocation, no diagnostics.','All 12 complete DTOs are deepStrictEqual against reverse frozen source, and hashes also match original baseline. Float values and all 371 daily bins are exact.','Candidate activityRows uses SQLite iterate; original .all/queryRows diagnostic hooks do NOT time that SQL or hydration. The field jsOutsideQueryAndSkillsMs is a residual including that SQLite iteration, normalization and JS, not pure JS. No per-row instrumentation affects plain calls.','Reverse sample is a coarse drift check, insufficient to prove statistical equivalence or stable p95. Range 371 has no structural optimization and observed small regressions must not be presented as improvements.','Candidate transport temporarily disconnected after range30, but all four candidate300k cases and report completed. Reports were recovered on the same Omarchy host; no benchmark replay occurred.'],rows};
writeFileSync(join(out,'comparison.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(rows.map(r=>({n:r.n,label:r.label,days:r.rangeDays,baselineP50:r.baseline.wallMs.p50,candidateP50:r.candidate.wallMs.p50,candidateP95:r.candidate.wallMs.p95,reverseP50:r.reverseBaseline.wallMs.p50,changePercent:r.wallP50ChangePercent,exact:true})),null,2));
