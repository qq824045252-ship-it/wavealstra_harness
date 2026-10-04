/** Inspectable, offline integrity proof for the Pi 1.0 upgrade and its real-task evidence. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
process.chdir(path.resolve(__dirname,'..'));const base='artifacts/pi100-upgrade';
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function files(root){const rows=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(f);else rows.push(path.relative(root,f).replaceAll('\\','/'));}}walk(root);return rows.sort();}
function fingerprint(){const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(p);else if(!p.includes(path.join('subagent','vendor')))files.push(p)}}for(const d of ['src','shared/src','app/remote/src','patches'])if(fs.existsSync(d))walk(d);for(const f of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','electron.vite.config.ts','scripts/build-pi-codemode-assets.mjs','scripts/build-subagent-runtime.mjs','scripts/build-subagent-context.mjs'])files.push(f);const h=crypto.createHash('sha256');for(const f of files.sort())h.update(f).update(fs.readFileSync(f));return h.digest('hex')}
const buildId=process.argv[2];if(!/^build-\d+$/.test(buildId??''))throw Error('Provide the exact build identifier');
const build=JSON.parse(fs.readFileSync(path.join(base,buildId,'build.json')));assert.equal(build.status,'passed');
const report={at:new Date().toISOString(),status:'running',buildId,sourceFingerprint:build.sourceFingerprint,asarSha256:build.asarSha256,packages:[],assets:[],checks:[],desktop:[]};
try{
 assert.equal(fingerprint(),build.sourceFingerprint,'Source changed after the verified build');report.sourceUnchanged=true;
 const names=['pi-ai','pi-agent-core','pi-coding-agent','pi-mcp','pi-codemode','pi-tui','pi-telemetry','chord'];
 for(const name of names){const dir='node_modules/@earendil-works/'+name;const version=JSON.parse(fs.readFileSync(path.join(dir,'package.json'))).version;assert.equal(version,'1.0.0');const up=path.join(base,'upstream',name,'package');const row={name,version};
  if(fs.existsSync(up)){const all=files(up);const changed=all.filter(f=>!fs.existsSync(path.join(dir,f))||sha(path.join(up,f))!==sha(path.join(dir,f)));let allowed=[];
   const patch=path.join('patches','@earendil-works__'+name+'@1.0.0.patch');if(fs.existsSync(patch)){const contents=fs.readFileSync(patch,'utf8');allowed=[...contents.matchAll(/^diff --git a\/(\S+) b\//gm)].map(m=>m[1]);row.patchBytes=Buffer.byteLength(contents);}
   assert.deepEqual(changed.sort(),allowed.sort(),'Unexpected patched files in '+name);Object.assign(row,{comparedFiles:all.length,changedFiles:changed,unmodifiedFiles:all.length-changed.length});
  }report.packages.push(row);
 }
 assert.equal(sha(build.cleanAsar),build.asarSha256);assert.equal(sha(build.asar),build.asarSha256);
 const unpack=path.join(build.cleanReleaseRoot,'resources/app.asar.unpacked/out/main');
 for(const f of ['codemode-worker.cjs','quickjs.wasm']){assert.equal(sha(path.join(unpack,f)),sha(path.join('out/main',f)));report.assets.push({file:f,sha256:sha(path.join(unpack,f))});}
 const child='capabilities/subagent/runtime';const source=path.join('out/main',child),target=path.join(unpack,child);const childFiles=files(source);assert.deepEqual(files(target),childFiles);for(const f of childFiles)assert.equal(sha(path.join(source,f)),sha(path.join(target,f)),'Child mismatch '+f);report.childRuntime={version:JSON.parse(fs.readFileSync(path.join(target,'package.json'))).version,filesCompared:childFiles.length,allMatch:true};
 assert.equal(sha(path.join(target,'docs/codemode.md')),sha('node_modules/@earendil-works/pi-coding-agent/docs/codemode.md'));
 for(const f of files(path.join(base,'checks')).filter(f=>f.endsWith('.json'))){const row=JSON.parse(fs.readFileSync(path.join(base,'checks',f)));report.checks.push({name:row.name,status:row.status,at:row.at,durationMs:row.durationMs});assert.equal(row.status,'passed',row.name+' did not pass');}
 const root=path.join(base,'desktop-live');for(const d of fs.readdirSync(root)){const f=path.join(root,d,'results.json');if(!fs.existsSync(f))continue;const r=JSON.parse(fs.readFileSync(f));if(r.asarSha256!==build.asarSha256)continue;
  assert.equal(r.status,'passed',d);assert.equal(r.temporaryCredentialsRemoved,true,'Temporary credentials remain: '+d);assert.deepEqual(r.rendererErrors,[]);assert(r.sessionAudit.some(s=>s.observedModels.includes(r.selectedModel)));assert(r.tests.every(t=>t.status==='passed'));
  report.desktop.push({report:f,model:r.selectedModel,buildReport:r.buildReport,sha256:r.asarSha256,status:r.status,temporaryCredentialsRemoved:true,tests:r.tests.map(t=>({name:t.name,result:t.result,streaming:t.streaming}))});
 }
 assert(report.desktop.length>=8,'Expected eight real desktop runs across two providers');assert(new Set(report.desktop.map(r=>r.model.split('/')[0])).size>=2);
 const worker=JSON.parse(fs.readFileSync('artifacts/pi099-closeout/portable-worker.json'));assert.equal(worker.passed,true);assert.equal(worker.temporaryCredentialsRemoved,true);report.standaloneWorker={passed:worker.passed,temporaryCredentialsRemoved:worker.temporaryCredentialsRemoved,result:worker.result};
 report.status='passed';
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1;}
fs.writeFileSync(path.join(base,'integrity-results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,packageCount:report.packages.length,checks:report.checks.length,realDesktopRuns:report.desktop.length,realStandaloneWorker:report.standaloneWorker?.passed,sourceFingerprint:report.sourceFingerprint,asarSha256:report.asarSha256,error:report.error},null,2));
