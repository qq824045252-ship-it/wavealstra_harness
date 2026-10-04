/** Bounded, serial acceptance runner. Full logs and exact exit statuses stay inspectable. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const stage=process.argv[2]||'regression';
const suites={
 regression:['test:pi099-worker-invocation','test:pi099-manager','test:pi099-migration','test:mcp-config-parse','test:mcp-mode','test:mcp','test:agent-loadout','test:session-lifecycle','test:mcp-execution-evidence','test:pi-autonomous-execution','test:pi-native-core-tools','test:compaction','test:compaction-policy-history','test:conversation-branch:native','test:pi-reasoning-stream','test:command-code-request','test:session-history-recovery','test:oauth-bundle','test:delegated-run','test:multi-model-consult','test:subagent-ipc-host','test:subagent-model-ui','typecheck'],
 build:['build'],
 pack:['remote:build','@pack'],
 desktop:['@desktop'],
};
if(!suites[stage])throw Error('Unknown acceptance stage');
const dir=path.resolve('artifacts/pi099-closeout',stage);fs.mkdirSync(dir,{recursive:true});
const report={stage,startedAt:new Date().toISOString(),pid:process.pid,status:'running',tests:[]};
const reportPath=path.join(dir,'results.json');const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
async function run(name){
 const row={name,status:'running',startedAt:new Date().toISOString()};report.tests.push(row);save();
 const log=fs.openSync(path.join(dir,name.replace(/[^a-zA-Z0-9_-]/g,'-')+'.log'),'w');
 const env={...process.env};env.PATH=path.join(root,'node_modules/.bin')+';'+path.dirname(process.execPath)+';'+(env.PATH||env.Path||'');
 const command=name==='@pack'?'pnpm exec electron-builder --dir --config.directories.output=release-pi099-closeout':name==='@desktop'?'node scripts/pi099-desktop-live.cjs':'pnpm run '+name;
 await new Promise(resolve=>{
  const child=cp.spawn('C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c',command],{cwd:root,env,stdio:['ignore',log,log],windowsHide:true});row.childPid=child.pid;save();
  let settled=false;
  const timer=setTimeout(()=>{row.timedOut=true;cp.spawn('C:/Windows/System32/taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});},name==='@desktop'?600000:300000);
  function end(code,signal,error){if(settled)return;settled=true;clearTimeout(timer);fs.closeSync(log);Object.assign(row,{status:code===0&&!signal&&!error&&!row.timedOut?'passed':'failed',code,signal,error,finishedAt:new Date().toISOString()});save();console.log(row.status.toUpperCase()+' '+name);resolve();}
  child.once('error',e=>end(null,null,e.message));child.once('close',(code,signal)=>end(code,signal));
 });
}
(async()=>{try{for(const name of suites[stage])await run(name);report.status=report.tests.every(t=>t.status==='passed')?'passed':'failed';}catch(e){report.status='failed';report.error=e.stack;}finally{report.finishedAt=new Date().toISOString();save();process.exitCode=report.status==='passed'?0:1;}})();
