/** Summarize inspectable acceptance evidence without copying credentials or test profiles. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');process.chdir(root);
const reportPaths=['artifacts/pi099-closeout/regression/results.json','artifacts/pi099-closeout/build/results.json','artifacts/pi099-closeout/pack/results.json','artifacts/pi099-closeout/desktop-live/results.json','artifacts/pi099-closeout/manager-lifecycle.json','artifacts/pi099-migration/integration.json','artifacts/pi099-migration/oauth.json','artifacts/pi099-migration/encryption.json','artifacts/pi099-migration/history.json','artifacts/pi099-migration/live-tasks.json','artifacts/pi099-closeout/portable-worker.json'];
const reports=reportPaths.map(file=>{if(!fs.existsSync(file))return {file,status:'not-run'};const r=JSON.parse(fs.readFileSync(file,'utf8'));const tests=r.tests||[];const passed=tests.filter(t=>t.passed===true||t.status==='passed').length;return {file,status:r.status||r.verdict||(r.passed===true?'passed':r.finishedAt&&tests.length&&passed===tests.length&&!r.setupError?'passed':'incomplete-or-failed'),tests:tests.length,passed,startedAt:r.startedAt,finishedAt:r.finishedAt,errors:tests.filter(t=>t.error||t.status==='failed'||t.passed===false).map(t=>({name:t.name,error:t.error})),error:r.error||r.setupError};});
const files=[];function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())walk(file);else files.push(file);}}
walk('src');walk('patches');files.push('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','electron.vite.config.ts','scripts/build-subagent-runtime.mjs','scripts/build-subagent-context.mjs','scripts/build-pi-codemode-assets.mjs');files.sort();
const hash=crypto.createHash('sha256');for(const file of files){hash.update(file);hash.update(fs.readFileSync(file));}
const fingerprint=hash.digest('hex');const build=reports.find(r=>r.file.includes('/build/'));
const touchedAfterBuild=build?.finishedAt?files.filter(file=>fs.statSync(file).mtimeMs>Date.parse(build.finishedAt)):[];
const identicalGenerated=[];
const afterBuild=touchedAfterBuild.filter(file=>{
 const normalized=file.replaceAll('\\','/');
 if(!normalized.startsWith('src/main/capabilities/subagent/vendor/'))return true;
 const built=normalized.replace('src/main/','out/main/');
 if(fs.existsSync(built)&&fs.readFileSync(file).equals(fs.readFileSync(built))){identicalGenerated.push(file);return false;}
 return true;
});
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const out={asOf:new Date().toISOString(),sourceFingerprint:fingerprint,sourceFiles:files.length,sourceModifiedAfterBuild:afterBuild,identicalGeneratedTouchesAfterBuild:identicalGenerated,legacyDependencyAbsent:!pkg.devDependencies?.['pi-mcp-adapter']&&!pkg.dependencies?.['pi-mcp-adapter'],piVersions:{ai:pkg.dependencies?.['@earendil-works/pi-ai'],agent:pkg.devDependencies?.['@earendil-works/pi-coding-agent']},reports};
fs.mkdirSync('artifacts/pi099-closeout',{recursive:true});fs.writeFileSync('artifacts/pi099-closeout/evidence-summary.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
