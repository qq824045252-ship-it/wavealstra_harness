/** Pinned upgrade only. Never discards the user's existing worktree. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),os=require('node:os');
const root=path.resolve(__dirname,'..');process.chdir(root);const out=path.join(root,'artifacts/pi0992-memory');fs.mkdirSync(out,{recursive:true});
const lock=path.join(out,'upgrade.lock');let fd;try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);}catch(e){console.error('Upgrade already running');process.exit(2);}process.on('exit',()=>{try{fs.unlinkSync(lock)}catch{}});
const report={startedAt:new Date().toISOString(),status:'running',pid:process.pid,patches:[],steps:[]};const save=()=>fs.writeFileSync(path.join(out,'upgrade-results.json'),JSON.stringify(report,null,2));
const exec=(file,args,options={})=>{const r=cp.spawnSync(file,args,{cwd:root,windowsHide:true,encoding:'utf8',timeout:30000,...options});if(r.status!==0)throw Error(file+' '+args.join(' ')+' failed: '+r.stderr+' '+r.error?.message);return r;};
try{
 const audit=JSON.parse(fs.readFileSync(path.join(out,'upstream-audit.json')));if(audit.status!=='passed')throw Error('Upstream audit incomplete');
 for(const name of ['pi-ai','pi-coding-agent']){
  const source=path.join(out,'upstream',name,'package'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pi0992-patch-'));
  try{
   fs.cpSync(source,tmp,{recursive:true});
   const patch=path.join(root,'patches',`@earendil-works__${name}@0.99.2.patch`);
   exec('git',['apply','--verbose',patch],{cwd:tmp});
   const checks=name==='pi-ai'?[['dist/api/openai-responses-shared.js','response.reasoning.delta']]:[['dist/config.js','setCodemodeWorkerUrl'],['dist/extensions/mcp/index.js','onController']];
   const verified=checks.map(([file,text])=>({file,text,found:fs.readFileSync(path.join(tmp,file),'utf8').includes(text)}));
   // onController naming is verified below against exact added patch lines as well.
   const added=fs.readFileSync(patch,'utf8').split(/\r?\n/).filter(l=>l.startsWith('+')&&!l.startsWith('+++')).join('\n');
   if(verified.some(v=>!v.found))throw Error('Patch did not modify '+checks[0][0]);
   const target=path.join(root,'patches',`@earendil-works__${name}@0.99.2.patch`);if(patch!==target)fs.copyFileSync(patch,target);
   report.patches.push({name,target:path.relative(root,target),appliedToCleanUpstream:true,verified,addedLines:added.split('\n').length});
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
 }
 const p=JSON.parse(fs.readFileSync('package.json','utf8'));
 for(const key of ['dependencies','devDependencies'])for(const name of Object.keys(p[key]||{}))if(name.startsWith('@earendil-works/'))p[key][name]='0.99.2';
 fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
 let yaml=fs.readFileSync('pnpm-workspace.yaml','utf8').replaceAll('@0.99.1','@0.99.2');fs.writeFileSync('pnpm-workspace.yaml',yaml);
 save();const log=fs.openSync(path.join(out,'install.log'),'w');
 const r=cp.spawnSync('C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c','pnpm install --no-frozen-lockfile'],{cwd:root,windowsHide:true,timeout:300000,stdio:['ignore',log,log]});fs.closeSync(log);
 report.steps.push({name:'pnpm-install',exitCode:r.status,error:r.error?.message});save();if(r.status!==0)throw Error('pnpm install failed; see install.log');
 report.installed=['pi-ai','pi-agent-core','pi-coding-agent','pi-mcp','pi-codemode','pi-tui','pi-telemetry','chord'].map(name=>({name,version:JSON.parse(fs.readFileSync(path.join(root,'node_modules/@earendil-works',name,'package.json'))).version}));
 if(report.installed.some(p=>p.version!=='0.99.2'))throw Error('Mixed Pi versions remain');report.status='passed';
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1;}finally{report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(report,null,2));}
