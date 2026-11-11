import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {listWorkspaceFiles} from '../src/main/workspace/WorkspaceService';
import {pathToFileURL} from 'node:url';
const baseline=(await import(pathToFileURL(process.env.WORKSPACE_BASELINE!).href)).listWorkspaceFiles as typeof listWorkspaceFiles;
const root=await mkdtemp(join(tmpdir(),'tree-perf-'));
const output:any[]=[];
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const median=(v:number[])=>{const sorted=[...v].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;};
try {
 for(const spec of [{dirs:1,files:100},{dirs:1,files:1000},{dirs:1,files:5000},{dirs:50,files:100}]){
  const dir=join(root,`${spec.dirs}x${spec.files}`);await mkdir(dir);
  for(let d=0;d<spec.dirs;d++){
   const sub=spec.dirs===1?dir:join(dir,`目录-${d}`);if(sub!==dir)await mkdir(sub);
   const names=Array.from({length:spec.files},(_,i)=>['研究报告','module','école','文件','test','résumé'][i%6]+`-${(i*7919)%spec.files}-${i}.txt`);
   for(let i=0;i<names.length;i+=50)await Promise.all(names.slice(i,i+50).map(n=>writeFile(join(sub,n),'')));
  }
  const expected=await baseline(dir),samples:Array<{pair:number;variant:string;wallMs:number;cpuMs:number}>=[];
  assert.deepEqual(await listWorkspaceFiles(dir),expected);
  for(let i=0;i<2;i++){await listWorkspaceFiles(dir);await baseline(dir)}
  for(let pair=0;pair<6;pair++)for(const variant of pair%2?['candidate','baseline']:['baseline','candidate']){
   const cpu=process.cpuUsage(),start=performance.now(),tree=await(variant==='baseline'?baseline:listWorkspaceFiles)(dir),wallMs=performance.now()-start,u=process.cpuUsage(cpu);assert.deepEqual(tree,expected);samples.push({pair,variant,wallMs,cpuMs:(u.user+u.system)/1000});
  }
  const summary=Object.fromEntries(['baseline','candidate'].map(variant=>{const values=samples.filter(x=>x.variant===variant);return[variant,{medianMs:median(values.map(x=>x.wallMs)),medianCpuMs:median(values.map(x=>x.cpuMs))}]}));
  const result={spec,rootEntries:expected.length,digest:hash(expected),completeTreeParityChecks:13,summary,samples};output.push(result);console.log(JSON.stringify({spec,summary}));
 }
 await writeFile(process.argv[2],JSON.stringify({head:process.env.SOURCE_HEAD,node:process.version,contract:'Actual production listWorkspaceFiles versus Git baseline; same synthetic directories; complete-tree parity; backend only',output},null,2));
}finally{await rm(root,{recursive:true,force:true});}
