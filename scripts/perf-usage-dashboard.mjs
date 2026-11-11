/** Run: TMPDIR=/home/vivion node scripts/perf-usage-dashboard.mjs [10000,100000,300000] [label] */
import { build } from 'esbuild';
import { spawnSync,execFileSync } from 'node:child_process';
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
const out=resolve('out/diagnostics/usage-dashboard');mkdirSync(out,{recursive:true});
const label=process.argv[3]||'baseline',entry=join(out,`${label}.cjs`);
const sourceRef=process.env.USAGE_SOURCE_REF;
const sources=['src/main/usage/UsageStatsService.ts','src/shared/usage-stats.ts'];
const oldSources=sourceRef?Object.fromEntries(sources.map(p=>[p,execFileSync('git',['show',`${sourceRef}:${p}`],{encoding:'utf8'})])):{};
const bulk=process.env.USAGE_BULK==='1';
if(bulk){if(sourceRef)throw Error('bulk experiment only supports current source');const p=sources[0],text=readFileSync(p,'utf8');if(text.split('.iterate(since)').length!==2)throw Error('Expected exactly one activityRows iterate');oldSources[p]=text.replace('.iterate(since)','.all(since)');}
await build({plugins:sourceRef||bulk?[{name:'reference-usage-sources',setup(b){b.onLoad({filter:/(UsageStatsService|usage-stats)\.ts$/},args=>{const p=sources.find(p=>resolve(p)===args.path);return p?{contents:oldSources[p]??readFileSync(p,'utf8'),loader:'ts',resolveDir:dirname(args.path)}:undefined;});}}]:[],entryPoints:['scripts/perf-usage-dashboard.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:entry});
writeFileSync(join(out,`${label}-metadata.json`),JSON.stringify({sourceRef:sourceRef||null,bulkExperiment:bulk,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),hashes:Object.fromEntries(['src/main/usage/UsageStatsService.ts','src/shared/usage-stats.ts','scripts/perf-usage-dashboard.ts'].map(p=>[p,createHash('sha256').update(oldSources[p]??readFileSync(p)).digest('hex')]))},null,2));
for(const n of (process.argv[2]||'10000,100000,300000').split(',')){
 const home=mkdtempSync(join(tmpdir(),'ud-'));
 const isolated={HOME:home,USERPROFILE:home,APPDATA:join(home,'roaming'),LOCALAPPDATA:join(home,'local'),XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),XDG_STATE_HOME:join(home,'state'),XDG_CACHE_HOME:join(home,'cache'),XDG_RUNTIME_DIR:join(home,'run'),XDG_CONFIG_DIRS:join(home,'config'),XDG_DATA_DIRS:join(home,'data'),TMPDIR:join(home,'tmp'),TMP:join(home,'tmp'),TEMP:join(home,'tmp')};
 for(const path of new Set(Object.values(isolated)))mkdirSync(path,{recursive:true,mode:0o700});
 try {const run=spawnSync(process.execPath,[entry,n,join(out,`${label}-${n}.json`)],{stdio:'inherit',env:{...process.env,...isolated},timeout:300000});if(run.status!==0)throw Error(`Benchmark ${n}: ${run.error||run.status}`);}finally{rmSync(home,{recursive:true,force:true});}
}
