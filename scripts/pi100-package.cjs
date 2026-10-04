/** Phased, synchronous packaging. Never overwrites the user's installed executable. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),os=require('node:os');
const root=path.resolve(__dirname,'..');process.chdir(root);const base=path.join(root,'artifacts/pi100-upgrade');
const pointer=path.join(base,'build-latest.json');const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function fingerprint(){const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(p);else if(!p.includes(path.join('subagent','vendor')))files.push(p)}}for(const d of ['src','shared/src','app/remote/src','patches'])if(fs.existsSync(d))walk(d);for(const f of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','electron.vite.config.ts','scripts/build-pi-codemode-assets.mjs','scripts/build-subagent-runtime.mjs','scripts/build-subagent-context.mjs'])files.push(f);const h=crypto.createHash('sha256');for(const f of files.sort())h.update(f).update(fs.readFileSync(f));return h.digest('hex')}
const phase=process.argv[2];let report,file;
if(phase==='prepare'){
 const stamp=new Date().toISOString().replace(/\D/g,'');const release='release-pi100-'+stamp;const out=path.join(base,'build-'+stamp);fs.mkdirSync(out,{recursive:true});file=path.join(out,'build.json');report={status:'prepared',startedAt:new Date().toISOString(),sourceFingerprint:fingerprint(),release,output:out,packed:path.join(root,release,'win-unpacked'),cleanReleaseRoot:path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData/Local'),'Programs/MyBuddy/portable',release),steps:[]};fs.writeFileSync(pointer,JSON.stringify({report:file},null,2)+'\n');
}else{
 const buildId=process.argv[3];
 if(buildId && !/^build-\d+$/.test(buildId))throw Error('Provide a build-<timestamp> identifier');
 // Pin a specific run so another build cannot change the target between phases.
 file=buildId ? path.join(base,buildId,'build.json') : JSON.parse(fs.readFileSync(pointer,'utf8')).report;
 report=JSON.parse(fs.readFileSync(file,'utf8'));
}
const save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
try{
 delete report.error;
 if(fingerprint()!==report.sourceFingerprint)throw Error('Source changed since prepare; rebuild from a new fingerprint');
 if(phase==='pack'){
  const built=JSON.parse(fs.readFileSync(path.join(base,'checks/build.json'),'utf8'));if(built.status!=='passed'||Date.parse(built.at)<Date.parse(report.startedAt))throw Error('Fresh desktop build required');
  const log=fs.openSync(path.join(report.output,'package.log'),'w');const env={...process.env};const temp=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'MyBuddy-build-temp',report.release);fs.mkdirSync(temp,{recursive:true});env.TEMP=temp;env.TMP=temp;
  const r=cp.spawnSync('C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c','pnpm exec electron-builder --dir --publish never --config.directories.output='+report.release],{cwd:root,env,stdio:['ignore',log,log],windowsHide:true,timeout:110000});fs.closeSync(log);if(r.status!==0)throw Error('Package failed: '+(r.error?.message||r.status));
  report.executable=path.join(report.packed,'MyBuddy.exe');report.asar=path.join(report.packed,'resources/app.asar');report.asarSha256=hash(report.asar);report.status='packaged';report.steps.push({name:'electron-builder',status:'passed',at:new Date().toISOString()});
 }else if(phase==='publish'){
  if(report.status!=='packaged')throw Error('Packaged state required');if(fs.existsSync(report.cleanReleaseRoot))throw Error('Refusing to overwrite a published release');fs.mkdirSync(report.cleanReleaseRoot,{recursive:true});fs.cpSync(report.packed,report.cleanReleaseRoot,{recursive:true});
  report.cleanExecutable=path.join(report.cleanReleaseRoot,'MyBuddy.exe');report.cleanAsar=path.join(report.cleanReleaseRoot,'resources/app.asar');report.cleanAsarSha256=hash(report.cleanAsar);if(report.cleanAsarSha256!==report.asarSha256)throw Error('Published bytes differ');
  const unpack=path.join(report.cleanReleaseRoot,'resources/app.asar.unpacked/out/main');const runtime=path.join(unpack,'capabilities/subagent/runtime');if(JSON.parse(fs.readFileSync(path.join(runtime,'package.json'),'utf8')).version!=='1.0.0')throw Error('Child runtime version mismatch');
  for(const f of ['codemode-worker.cjs','quickjs.wasm'])if(hash(path.join(unpack,f))!==hash(path.join(root,'out/main',f)))throw Error('Packaged asset mismatch '+f);
  if(hash(path.join(runtime,'docs/codemode.md'))!==hash('node_modules/@earendil-works/pi-coding-agent/docs/codemode.md'))throw Error('Child reference mismatch');
  report.sourceUnchanged=fingerprint()===report.sourceFingerprint;if(!report.sourceUnchanged)throw Error('Source changed while publishing');report.status='passed';report.steps.push({name:'clean-acl-publish-and-worker-integrity',status:'passed',at:new Date().toISOString()});report.finishedAt=new Date().toISOString();
 }else if(phase!=='prepare')throw Error('Use prepare, pack, or publish');
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1}finally{save();console.log(JSON.stringify({status:report.status,report:file,executable:report.cleanExecutable||report.executable,sourceFingerprint:report.sourceFingerprint,error:report.error},null,2))}
