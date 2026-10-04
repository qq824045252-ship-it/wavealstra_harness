/** Read-only upstream audit and working-tree snapshot for the pinned Pi upgrade. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');process.chdir(root);
const out=path.join(root,'artifacts/pi0992-memory');fs.mkdirSync(out,{recursive:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const report={startedAt:new Date().toISOString(),packages:[],patches:[],status:'running'};
const save=()=>fs.writeFileSync(path.join(out,'upstream-audit.json'),JSON.stringify(report,null,2));
(async()=>{try{
 const baseline=path.join(out,'pre-upgrade');fs.mkdirSync(baseline,{recursive:true});
 for(const p of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])if(!fs.existsSync(path.join(baseline,p)))fs.copyFileSync(p,path.join(baseline,p));
 const git=cp.spawnSync('git',['--no-optional-locks','-c','core.fsmonitor=false','diff','--binary'],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:12*1024*1024});
 if(git.status===0&&!fs.existsSync(path.join(baseline,'working-tree.patch')))fs.writeFileSync(path.join(baseline,'working-tree.patch'),git.stdout);
 const names=['pi-ai','pi-agent-core','pi-coding-agent','pi-mcp','pi-codemode','pi-tui','pi-telemetry','chord'];
 for(const name of names){
  const full='@earendil-works/'+name,url='https://registry.npmjs.org/'+encodeURIComponent(full)+'/0.99.2';
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error(url+' '+response.status);
  const meta=await response.json();report.packages.push({name:full,version:meta.version,dependencies:meta.dependencies,integrity:meta.dist?.integrity,tarball:meta.dist?.tarball});
  fs.writeFileSync(path.join(out,name+'-0.99.2-metadata.json'),JSON.stringify(meta,null,2));
  if(['pi-ai','pi-agent-core','pi-coding-agent','pi-mcp','pi-codemode'].includes(name)){
   const data=Buffer.from(await (await fetch(meta.dist.tarball,{signal:AbortSignal.timeout(30000)})).arrayBuffer());
   const [alg,expected]=meta.dist.integrity.split('-');if(crypto.createHash(alg).update(data).digest('base64')!==expected)throw Error('Tarball integrity mismatch '+full);
   const dir=path.join(out,'upstream',name);fs.mkdirSync(dir,{recursive:true});const tarball=path.join(dir,'package.tgz');fs.writeFileSync(tarball,data);
   const extract=cp.spawnSync('tar',['-xzf',tarball,'-C',dir],{windowsHide:true,encoding:'utf8',timeout:30000});if(extract.status!==0)throw Error('tar failed: '+extract.stderr);
   let changes=[];const installed=path.join(root,'node_modules/@earendil-works',name),fresh=path.join(dir,'package');
   const walk=d=>{for(const entry of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,entry.name);if(entry.isDirectory())walk(p);else if(/\.(js|ts|md)$/.test(entry.name)&&!entry.name.endsWith('.map')){const rel=path.relative(fresh,p),old=path.join(installed,rel);if(!fs.existsSync(old)||hash(fs.readFileSync(old))!==hash(fs.readFileSync(p)))changes.push(rel.replaceAll('\\','/'));}}};walk(fresh);
   report.packages.at(-1).changedFiles=changes;
   if(fs.existsSync(path.join(fresh,'CHANGELOG.md'))){const text=fs.readFileSync(path.join(fresh,'CHANGELOG.md'),'utf8');fs.writeFileSync(path.join(out,name+'-changelog-head.md'),text.slice(0,24000));}
   const patch=path.join(root,'patches','@earendil-works__'+name+'@0.99.1.patch');
   if(fs.existsSync(patch)){
    const result=cp.spawnSync('git',['apply','--check','--unsafe-paths',patch],{cwd:fresh,encoding:'utf8',windowsHide:true,timeout:10000});
    report.patches.push({name,patch:path.relative(root,patch),appliesCleanly:result.status===0,stdout:result.stdout,stderr:result.stderr});
   }
  }
  save();console.log('AUDIT '+full+' '+meta.version);
 }
 report.status='passed';
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1;}finally{report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,patches:report.patches,error:report.error}));}})();
