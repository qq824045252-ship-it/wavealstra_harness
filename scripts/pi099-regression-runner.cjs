const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const dir=path.join(root,'artifacts/pi099-migration/regression');fs.mkdirSync(dir,{recursive:true});
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const names=process.argv.slice(2).length?process.argv.slice(2):[
 'test:mcp-config-parse','test:mcp-mode','test:mcp','test:agent-loadout','test:session-lifecycle',
 'test:mcp-execution-evidence','test:pi-autonomous-execution','test:pi-native-core-tools',
 'test:compaction','test:compaction-policy-history','test:conversation-branch:native',
 'test:pi-reasoning-stream','test:command-code-request','test:session-history-recovery','test:oauth-bundle'
];
const report={startedAt:new Date().toISOString(),tests:[]};const out=path.join(dir,'results.json');
const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));
(async()=>{
 for(const name of names){
  const row={name,status:'running',startedAt:new Date().toISOString()};report.tests.push(row);save();
  if(!pkg.scripts[name]){Object.assign(row,{status:'failed',error:'Script not found'});save();continue;}
  const log=fs.openSync(path.join(dir,name.replaceAll(':','-')+'.log'),'w');
  await new Promise(done=>{
   const env={...process.env};env.PATH=path.join(root,'node_modules/.bin')+';'+path.dirname(process.execPath)+';'+(env.PATH||env.Path||'');
   const child=cp.spawn('C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c','pnpm run '+name],{cwd:root,env,stdio:['ignore',log,log],windowsHide:true});
   const timer=setTimeout(()=>{row.timedOut=true;cp.spawn('C:/Windows/System32/taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});},180000);
   const end=(code,error)=>{clearTimeout(timer);fs.closeSync(log);Object.assign(row,{status:code===0&&!row.timedOut?'passed':'failed',code,error,finishedAt:new Date().toISOString()});save();console.log(row.status.toUpperCase()+' '+name);done();};
   child.once('error',err=>end(null,err.message));child.once('exit',code=>end(code));
  });
 }
 report.finishedAt=new Date().toISOString();save();process.exitCode=report.tests.some(t=>t.status!=='passed')?1:0;
})().catch(error=>{report.error=error.stack;save();process.exitCode=1;});
