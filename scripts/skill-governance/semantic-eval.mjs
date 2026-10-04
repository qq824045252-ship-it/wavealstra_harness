// Reuse MyBuddy's semantic judge prompt; never send expected labels to the model.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {configuration,request} from './payload/gemini-agent-platform/tools/gemini_ap.mjs';
const base=path.resolve('scripts/skill-governance'), root='C:/Users/servi/.mybuddy/skills';
const get=rel=>fs.readFileSync(fs.existsSync(path.join(base,'payload',rel))?path.join(base,'payload',rel):path.join(root,rel),'utf8');
const source=fs.readFileSync('src/main/skills/SkillAuthoringGenerator.ts','utf8');
const prompt=source.match(/export const SKILL_TRIGGER_EVAL_PROMPT = `([\s\S]*?)`;/)[1];
const config=configuration(path.join(root,'gemini-agent-platform/config.env'));
const model='gemini-2.5-flash';
const selected=process.argv.slice(2);
const ids=fs.readdirSync(root).filter(id=>id!=='weekly-summary'&&fs.existsSync(path.join(root,id,'SKILL.md'))&&(!selected.length||selected.includes(id)));
const oldFile=path.join(base,'semantic-eval.json');
const results=selected.length&&fs.existsSync(oldFile)?JSON.parse(fs.readFileSync(oldFile,'utf8')).results.filter(r=>!selected.includes(r.skill)):[];
async function evaluate(id){
 const skill=get(id+'/SKILL.md'), definitions=JSON.parse(get(id+'/evals/trigger.json')).cases;
 const req=request({endpoint:'agentplatform',model,prompt:`## Target SKILL.md\n${skill}\n\n## Eval cases (expected labels withheld)\n${JSON.stringify(definitions.map((c,index)=>({index,prompt:c.prompt})))}`,'system-instruction':prompt,temperature:'0','max-output-tokens':'8192'},config);
 req.body.generationConfig.responseMimeType='application/json';
 const resp=await fetch(req.url,{method:'POST',headers:req.headers,body:JSON.stringify(req.body),signal:AbortSignal.timeout(180000)});
 const data=await resp.json();
 if(!resp.ok)throw Error(`HTTP ${resp.status} ${String(data.error?.message||'request failed').replaceAll(req.headers['x-goog-api-key'],'[REDACTED]')}`);
 const text=data.candidates?.[0]?.content?.parts?.filter(p=>p.text&&!p.thought).map(p=>p.text).join('');
 const decisions=JSON.parse(text).cases;
 if(!Array.isArray(decisions)||decisions.length!==definitions.length||new Set(decisions.map(c=>c.index)).size!==definitions.length)throw Error('Judge returned incomplete decisions');
 const cases=definitions.map((c,index)=>{const decision=decisions.find(d=>d.index===index);return {...c,actual:decision?.actual||'unknown',reason:decision?.reason,pass:decision?.actual===c.expected};});
 return {skill:id,model,skillContentHash:createHash('sha256').update(skill).digest('hex'),kind:'semantic-judge-not-runtime-routing',passed:cases.filter(c=>c.pass).length,total:cases.length,cases};
}
// Fail the first live request explicitly before spending on a whole suite.
try {
 const first=await evaluate(ids.shift());results.push(first);console.log(first.skill,first.passed+'/'+first.total);
 await Promise.all(Array.from({length:3},async()=>{while(ids.length){const id=ids.shift();try{const r=await evaluate(id);results.push(r);console.log(id,r.passed+'/'+r.total);}catch(e){results.push({skill:id,error:e.message});console.error(id,e.message);}}}));
}catch(e){results.push({error:e.message});console.error(e.message);}
fs.writeFileSync(path.join(base,'semantic-eval.json'),JSON.stringify({evaluatedAt:new Date().toISOString(),model,results},null,2)+'\n');
process.exitCode=results.some(r=>r.error||r.passed!==r.total)?1:0;
