import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const root='C:/Users/servi/.mybuddy/skills',base=path.resolve('scripts/skill-governance');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'skill-governance-workflows-'));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function run(name,args,cwd=temp,env={}) {
 const child=spawn('C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c',args.map(quote).join(' ')],{cwd,env:{...process.env,...env},windowsHide:true});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const status=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res);});
 console.log(name,status);
 if(status!==0)throw Error(name+': '+stderr+stdout);
 return {name,status,stdout:stdout.slice(0,1800),stderr:stderr.slice(0,700)};
}
const results=[];
async function check(name,fn){try{results.push({name,pass:true,detail:await fn()});}catch(e){results.push({name,pass:false,error:e.message});console.error(e.message);}}
await check('officecli-real-dom',async()=>{
 const doc=path.join(temp,'smoke.docx');
 await run('office-create',['officecli','create',doc]);
 await run('office-add',['officecli','add',doc,'/body','--type','paragraph','--prop','text=Governance 42'],temp,{MSYS2_ARG_CONV_EXCL:'*'});
 await run('office-save',['officecli','save',doc]);
 const view=await run('office-view',['officecli','view',doc,'text']);assert.ok(view.stdout.includes('Governance 42'));
 await run('office-close',['officecli','close',doc]);
 return {path:doc,readback:'Governance 42',msysConversionExcluded:true};
});
await check('academic-formula-citation-roundtrip',async()=>{
 const input=path.join(temp,'source.txt'), masked=path.join(temp,'masked.json'), restored=path.join(temp,'restored.txt');
 fs.writeFileSync(input,'We use $E=mc^2$ following \\cite{einstein1905}. Measured value is 42.');
 const cli=['uv','run','--no-project','python',root+'/academic-translation/scripts/preserve_latex.py'];
 await run('latex-mask',[...cli,'mask','--in',input,'--out',masked]);
 await run('latex-restore',[...cli,'restore','--in',masked,'--out',restored]);
 await run('latex-verify',[...cli,'verify','--original',input,'--translated',restored]);
 assert.equal(fs.readFileSync(restored,'utf8'),fs.readFileSync(input,'utf8'));return 'formula/cite/number roundtrip byte-identical';
});
await check('weekly-report-real-json',async()=>{
 const spec=path.join(temp,'weekly-spec.json'),out=path.join(temp,'weekly.json');
 fs.writeFileSync(spec,JSON.stringify({weekNum:29,year:2026,days:{monday:{slot1:{project:'Smoke fixture',content:'Verify export',issues:'',verification:'pending'}}}}));
 await run('weekly-export',['uv','run','--no-sync','tools/build_report_json.py','--spec',spec,'--out',out],'C:/Users/servi/Desktop/周报系统');
 const data=JSON.parse(fs.readFileSync(out,'utf8'));assert.equal(data.weeks['2026_week_29'].dailyRecords.monday.records.slot1.content,'Verify export');return 'generated JSON only; no import/submission';
});
await check('archify-real-validation',async()=>await run('archify-validate',['node','bin/archify.mjs','validate','architecture','examples/brand-aware-delivery.architecture.json','--quality','showcase','--json'],root+'/archify'));
await check('pptd-real-local-export',async()=>{
 const output=path.join(temp,'smoke.pptx');
 const result=await run('pptd-export',['uv','run','--no-project','python',root+'/open-kimi-ppt/scripts/export_pptx.py',root+'/open-kimi-ppt/tests/fixtures/minimal/minimal.pptd','--output',output]);
 assert.ok(fs.statSync(output).size>1000);return {...result,path:output};
});
fs.writeFileSync(path.join(base,'workflow-smoke.json'),JSON.stringify({temp,results},null,2)+'\n');
process.exitCode=results.some(r=>!r.pass)?1:0;
