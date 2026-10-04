import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {configuration} from './payload/gemini-agent-platform/tools/gemini_ap.mjs';
const root='C:/Users/servi/.mybuddy/skills',base=path.resolve('scripts/skill-governance');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'skill-governance-cli-'));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function run(name,args,cwd=temp,env=process.env){
 const child=spawn('C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c',args.map(quote).join(' ')],{cwd,env,windowsHide:true});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>child.kill(),90000);
 const status=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res);});clearTimeout(timer);
 const record={name,status,stdout:stdout.slice(0,1600),stderr:stderr.slice(0,1000)};
 console.log(name,status);return record;
}
const jobs=[
 ['easyeda-health',['easyeda','health']],
 ['officecli-version',['officecli','--version']],
 ['epro2kicad-help',['C:/Program Files/KiCad/10.0/bin/python.exe','C:/Users/servi/Documents/GitHub/epro2kicad/epro2kicad.py','--help']],
 ['kicad-cli-version',['C:/Program Files/KiCad/10.0/bin/kicad-cli.exe','version']],
 ['npu-ocr-help',['C:/Users/servi/Documents/GitHub/OCR_NPU/dist/OCR_NPU_CLI/OCR_NPU_CLI.exe','--help']],
 ['cheaper-image-help',['uv','run','--no-project','python',root+'/cheaper-inference-image/scripts/generate_image.py','--help']],
 ['meeting-transcribe-invalid-file-boundary',['uv','run','--no-sync','transcribe_wav.py','--help'],'C:/Users/servi/Documents/GitHub/whisper-voice-ime'],
 ['projectlibre-help',['uv','run','--no-project','python','C:/Users/servi/Documents/ProjectLibre-Demo/generate_project.py','--help']],
 ['pptx-export-help',['uv','run','--no-project','python',root+'/open-kimi-ppt/scripts/export_pptx.py','--help']],
 ['archify-doctor',['node','bin/archify.mjs','doctor'],root+'/archify'],
 ['code-view-filesystem',['bash','-c','rg --files src -g "*.ts" -g "*.tsx" | wc -l'],process.cwd()],
];
const results=[];
// Independent read-only entry checks; do not start multiple mutable application jobs.
await Promise.all(Array.from({length:3},async()=>{while(jobs.length){const [name,args,cwd]=jobs.shift();try{results.push(await run(name,args,cwd));}catch(e){results.push({name,error:e.message});}}}));
const fixture=path.join(temp,'project.json');
fs.writeFileSync(fixture,JSON.stringify({name:'Governance smoke',start_date:'2026-09-07',tasks:[{id:1,name:'Migration',summary:true},{id:2,name:'Prepare',duration_days:1,parent:1},{id:3,name:'Verify',duration_days:1,deps:[2],parent:1}]}));
results.push(await run('projectlibre-real-xml',['uv','run','--no-project','python','C:/Users/servi/Documents/ProjectLibre-Demo/generate_project.py',fixture,'-o',path.join(temp,'project.xml')]));
results.push(await run('academic-latex-real-verify',['uv','run','--no-project','python',root+'/academic-translation/scripts/preserve_latex.py','--help']));
const config=configuration(root+'/gemini-agent-platform/config.env');
results.push(await run('gemini-real-cli-text',['node',path.join(base,'payload/gemini-agent-platform/tools/gemini_ap.mjs'),'--model','gemini-2.5-flash','--prompt','Reply with exactly GOVERNANCE_OK.','--max-output-tokens','128'],temp,{...process.env,...config}));
fs.writeFileSync(path.join(base,'cli-smoke.json'),JSON.stringify({temp,results},null,2)+'\n');
// This CLI has no --help option; it correctly rejects it as a missing input file.
process.exitCode=results.some(r=>r.error||r.status!==(r.name==='meeting-transcribe-invalid-file-boundary'?1:0))?1:0;
