import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {configuration,request,saveResponse} from './payload/gemini-agent-platform/tools/gemini_ap.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'skill-governance-unit-'));
const config={GEMINI_AP_API_KEY:'fixture-secret',GEMINI_AP_PROJECT:'fixture-project',GEMINI_API_KEY:'developer-secret'};
test('Gemini config precedence and quoted config values',()=>{
 const file=path.join(temp,'config.env');fs.writeFileSync(file,'# example\nGEMINI_AP_MODEL="file-model"\nGEMINI_AP_API_KEY=from-file\n');
 const value=configuration(file,{GEMINI_AP_MODEL:'environment-model'},false);
 assert.equal(value.GEMINI_AP_MODEL,'environment-model');assert.equal(value.GEMINI_AP_API_KEY,'from-file');
 const req=request({prompt:'zero temperature',endpoint:'agentplatform',temperature:'0',model:'cli-model'},value.GEMINI_AP_PROJECT?value:{...value,GEMINI_AP_PROJECT:'project'});
 assert.equal(req.model,'cli-model');assert.equal(req.body.generationConfig.temperature,0);
});
test('Gemini native JSON, image encoding and headers for both endpoints',()=>{
 const image=path.join(temp,"中文 ' image.png");fs.writeFileSync(image,Buffer.from([1,2,3]));
 for(const endpoint of ['agentplatform','developer']){
 const req=request({prompt:'quotes " $ and 中文',endpoint,'image-path':image,'generate-image':true,'aspect-ratio':'16:9','top-p':'0'},config);
 assert.equal(req.body.contents[0].parts[1].inlineData.data,'AQID');assert.ok(!req.url.includes('secret'));assert.ok(req.headers['x-goog-api-key']);
 assert.deepEqual(req.body.generationConfig.responseModalities,['TEXT','IMAGE']);assert.equal(req.body.generationConfig.topP,0);
 }
});
test('Gemini fails on invalid inputs before request and does not silently ignore image',()=>{
 assert.throws(()=>request({prompt:'x',endpoint:'agentplatform','image-path':path.join(temp,'missing.png')},config));
 assert.throws(()=>request({prompt:'x',endpoint:'agentplatform',temperature:'NaN'},config));
 assert.throws(()=>request({prompt:'x',endpoint:'agentplatform',size:'512'},config));
 assert.throws(()=>request({prompt:'x',endpoint:'invalid'},config));
 assert.throws(()=>saveResponse({candidates:[{content:{parts:[{text:'cannot generate'}]}}]},{'generate-image':true},'m'));
 assert.throws(()=>saveResponse({promptFeedback:{blockReason:'BLOCKED'}},{},'m'));
});
test('Gemini camelCase/snake_case image output, MIME extension and collision refusal',()=>{
 const response={candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'AQID'}},{inline_data:{mime_type:'image/jpeg',data:'BAUG'}}]}}]};
 const args={'out-image':path.join(temp,"输出 ' file.webp"),'generate-image':true};
 const files=saveResponse(response,args,'model');
 assert.equal(files.length,2);assert.ok(files[0].endsWith('_1.png'));assert.ok(files[1].endsWith('_2.jpg'));
 assert.deepEqual(fs.readFileSync(files[1]),Buffer.from([4,5,6]));
 assert.throws(()=>saveResponse(response,args,'model'),/EEXIST/);
});
test('CLI validation errors stay nonzero with diagnostic stderr',()=>{
 for(const file of ['fastcopy-copy/scripts/fcopy.mjs','matlab-r2025b/scripts/matlab-run.mjs']){
   const result=spawnSync(process.execPath,[path.resolve('scripts/skill-governance/payload',file)],{encoding:'utf8'});
   assert.equal(result.status,2);assert.ok(result.stderr.trim());
 }
});
test('deployment accepts reviewed original bytes, is idempotent and preserves drift',()=>{
 const work=path.join(temp,'deployment'),root=path.join(work,'installed'),skill=path.join(root,'fixture');
 fs.mkdirSync(skill,{recursive:true});fs.mkdirSync(path.join(work,'payload/fixture'),{recursive:true});
 fs.writeFileSync(path.join(skill,'SKILL.md'),'original');fs.writeFileSync(path.join(work,'payload/fixture/SKILL.md'),'reviewed');
 const hash=s=>createHash('sha256').update(s).digest('hex');
 const manifest={sourceRoot:root,files:[{file:'fixture/SKILL.md',before:hash('intermediate'),originalBefore:hash('original'),after:hash('reviewed')}]};
 fs.writeFileSync(path.join(work,'manifest.json'),JSON.stringify(manifest));
 fs.writeFileSync(path.join(work,'deploy.mjs'),fs.readFileSync('scripts/skill-governance/deploy.mjs'));
 const invoke=(...args)=>spawnSync(process.execPath,[path.join(work,'deploy.mjs'),...args],{encoding:'utf8'});
 assert.equal(invoke().status,0);assert.equal(fs.readFileSync(path.join(skill,'SKILL.md'),'utf8'),'original');
 assert.equal(invoke('--apply').status,0);assert.equal(fs.readFileSync(path.join(skill,'SKILL.md'),'utf8'),'reviewed');
 assert.match(invoke('--apply').stdout,/Already applied/);
 fs.writeFileSync(path.join(skill,'SKILL.md'),'user concurrent edit');
 assert.notEqual(invoke('--apply').status,0);assert.equal(fs.readFileSync(path.join(skill,'SKILL.md'),'utf8'),'user concurrent edit');
 manifest.files[0].file='../outside/SKILL.md';fs.writeFileSync(path.join(work,'manifest.json'),JSON.stringify(manifest));
 assert.notEqual(invoke('--apply').status,0);
});
