import fs from 'node:fs';
import path from 'node:path';
const file=path.join(process.env.USERPROFILE,'.mybuddy/sessions/--C--Users-servi-Documents-GitHub-wavealstra_harness--/2026-11-02T00-38-27-671Z_01a199b1-7a56-7415-b47b-0cdd635c3fc0.jsonl');
const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
console.log(JSON.stringify(rows.slice(0,9).map((r,i)=>({line:i+1,type:r.type,fields:Object.keys(r),role:r.message?.role,messageFields:r.message?Object.keys(r.message):[],sectionShapes:r.message?.sections?Object.keys(r.message.sections):[]})),null,2));
