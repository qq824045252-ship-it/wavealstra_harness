/** Reproduce baseline/candidate on identical synthetic databases, no product build. */
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const out=resolve('out/diagnostics/work-search'); mkdirSync(out,{recursive:true});
const baseline=process.argv[2] || '300a675679250697e27861c48861d2e342a34aee';
const source='src/main/agent/work/WorkListQuery.ts';
const legacy=execFileSync('git',['show',`${baseline}:${source}`],{encoding:'utf8'});
const reports={};
for(const label of ['baseline','candidate']) {
  const entry=join(out,`${label}.cjs`), home=mkdtempSync(join(out,`${label}-profile-`));
  await build({entryPoints:['scripts/perf-work-list-search.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:entry,
    plugins:label==='baseline'?[{name:'baseline-work-list-query',setup(build){
      build.onLoad({filter:/[/\\]WorkListQuery\.ts$/},args=>({contents:legacy,loader:'ts',resolveDir:dirname(args.path)}));
    }}]:[]});
  const report=join(out,`${label}.json`);
  const run=spawnSync(process.execPath,['scripts/test-guard.mjs',entry,'--run',join(home,'work.db'),report],{
    stdio:'inherit',env:{...process.env,HOME:home,GUARD_HOME:'host',GUARD_TIMEOUT_S:'180'}});
  if(run.status!==0)process.exit(run.status??1);
  reports[label]=JSON.parse(readFileSync(report,'utf8'));
}
const comparison=reports.candidate.results.map((result,i)=>{
  const before=reports.baseline.results[i];assert.equal(result.name,before.name);assert.equal(result.digest,before.digest,`${result.name} full result parity`);
  return {name:result.name,beforeMs:before.medianMs,afterMs:result.medianMs,changePercent:(result.medianMs/before.medianMs-1)*100,exactResultParity:true};
});
const hash=value=>createHash('sha256').update(value).digest('hex');
const report={baseline,sourceHashes:{baseline:hash(legacy),candidate:hash(readFileSync(source)),fixture:hash(readFileSync('scripts/perf-work-list-search.ts'))},head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),changedSources:execFileSync('git',['diff','--name-only'],{encoding:'utf8'}).trim().split('\n'),comparison,...reports};
writeFileSync(join(out,'comparison.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(comparison,null,2));
