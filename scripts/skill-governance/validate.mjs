import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
const base=path.resolve('scripts/skill-governance'),payload=path.join(base,'payload');
const manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
const root=manifest.sourceRoot,errors=[],warnings=[],rows=[];
const priorFile=path.join(base,'validation.json');
const originalCounts=new Map(fs.existsSync(priorFile)?JSON.parse(fs.readFileSync(priorFile,'utf8')).rows.map(r=>[r.skill,r.before]):[]);
const resolve=rel=>fs.existsSync(path.join(payload,rel))?path.join(payload,rel):path.join(root,rel);
const read=rel=>fs.readFileSync(resolve(rel),'utf8');
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const file of manifest.files){
 if(sha(fs.readFileSync(path.join(payload,file.file)))!==file.after) errors.push(`Hash mismatch ${file.file}`);
 if(file.file.endsWith('.mjs')) {
   const result=spawnSync(process.execPath,['--check',path.join(payload,file.file)],{encoding:'utf8'});
   if(result.status!==0)errors.push(result.stderr);
 }
}
const allCases=new Map();
for(const id of fs.readdirSync(root)){
 const rel=id+'/SKILL.md';if(!fs.existsSync(resolve(rel)))continue;
 const text=read(rel), fm=text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
 if(!fm){errors.push(`Missing frontmatter ${id}`);continue;}
 let meta;try{meta=YAML.parse(fm[1]);}catch(e){errors.push(`${id}: ${e.message}`);continue;}
 if(meta.name!==id||!meta.description)errors.push(`Identity/frontmatter ${id}`);
 const old=fs.readFileSync(path.join(root,rel),'utf8');
 const oldMeta=YAML.parse(old.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
 for(const key of Object.keys(oldMeta)) if(key!=='description'&&JSON.stringify(meta[key])!==JSON.stringify(oldMeta[key])) errors.push(`Unexpected metadata change ${id}:${key}`);
 const evalRel=id+'/evals/trigger.json';let positive=0,negative=0;
 if(fs.existsSync(resolve(evalRel))){
   const data=JSON.parse(read(evalRel));
   if((data.schemaVersion!==undefined&&data.schemaVersion!==1)||(data.skill!==undefined&&data.skill!==id)||!Array.isArray(data.cases))errors.push(`Eval schema ${id}`);
   const seen=new Map();
   for(const c of data.cases){
     if(!c.prompt?.trim()||!['trigger','no-trigger'].includes(c.expected))errors.push(`Invalid case ${id}`);
     if(seen.has(c.prompt))errors.push(`Duplicate/contradictory case ${id}: ${c.prompt}`);
     seen.set(c.prompt,c.expected);c.expected==='trigger'?positive++:negative++;
   }
   allCases.set(id,seen);
 }
 if(id!=='weekly-summary'&&(positive<4||negative<4))errors.push(`Too few cases ${id}: ${positive}/${negative}`);
 if(id!=='weekly-summary'&&text.length>12000)errors.push(`Oversized ${id}: ${text.length}`);
 rows.push({skill:id,before:originalCounts.get(id)??old.length,chars:text.length,positive,negative,status:id==='weekly-summary'?'cleanup-candidate':text.length>8000?'context-reviewed':'pass'});
}
for(const [a,b] of [['dimagent-debug','root-cause-debugging'],['officecli','open-kimi-ppt'],['gemini-agent-platform','cheaper-inference-image']]){
 for(const [prompt,expected] of allCases.get(a)) if(expected==='trigger'&&allCases.get(b).get(prompt)==='trigger')errors.push(`Cross-positive ${a}/${b}: ${prompt}`);
 for(const [from,to] of [[a,b],[b,a]]) if(![...allCases.get(from)].some(([p,e])=>e==='trigger'&&allCases.get(to).get(p)==='no-trigger'))errors.push(`Missing cross-negative ${from}/${to}`);
}
// Check only real relative Markdown resource links, excluding examples and URLs.
for(const {file} of manifest.files.filter(f=>f.file.endsWith('.md'))){
 const text=read(file);
 for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
   const link=match[1].split('#')[0];
   if(!link||/^(?:https?:|file:|#|\/|<)/.test(link)||/[{}]/.test(link))continue;
   const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),link));
   if(!fs.existsSync(resolve(target))) warnings.push(`Unresolved link ${file}: ${link}`);
 }
 // Syntax-check actual Bash code blocks; placeholders in CLI manuals are documented, not executable samples.
 if(['code-view','npu-ocr','meeting-transcribe','projectlibre-gen','matlab-r2025b','gemini-agent-platform','fastcopy-copy','cheaper-inference-image','epro2kicad'].includes(file.split('/')[0])) {
  for(const m of text.matchAll(/```bash\n([\s\S]*?)\n```/g)){
   if(m[1].includes('<核心类名>')||m[1].includes('<符号名>'))continue;
   const result=spawnSync('C:/Program Files/Git/bin/bash.exe',['-n'],{input:m[1],encoding:'utf8'});
   if(result.status!==0)errors.push(`Bash syntax ${file}: ${result.stderr}`);
  }
 }
}
fs.writeFileSync(path.join(base,'validation.json'),JSON.stringify({errors,warnings,rows},null,2)+'\n');
console.log(JSON.stringify({errors,warnings,skills:rows.length,formal:rows.filter(r=>r.skill!=='weekly-summary').length,cases:rows.reduce((n,r)=>n+r.positive+r.negative,0),contexts:rows.filter(r=>r.chars>8000).map(r=>[r.skill,r.chars])},null,2));
process.exitCode=errors.length?1:0;
