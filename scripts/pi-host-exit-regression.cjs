/** Serial regression run in disposable test profiles; no user tasks are submitted. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const groups = {
  execution: ['test:pi-host-boundary','test:pi-host-native','test:pi-host-control','test:pi-native-control','test:pi-native-lifecycle','test:pi-autonomous-execution','test:pi-native-core-tools','test:prompt-execution','test:prompt-submission','test:session-lifecycle','test:message-lifecycle','test:streaming-send','test:regenerate-lifecycle','test:regenerate-connection-runtime','test:regenerate-stop-runtime','test:conversation-runtime','test:conversation-input','test:conversation-runtime-ui','test:conversation-branch'],
  safety: ['test:verified-code-execution','test:mcp-execution-evidence','test:mcp-mode','test:session-approval-bridge','test:architecture','test:harness-quality','test:runtime-orchestrator'],
  web: ['test:web-access-capability','test:web-access-convergence','test:web-artifact-runtime','test:shell-arguments',],
  memory: ['test:memory','test:memory-cognition','test:memory-projection-deletion','test:memory-lifecycle','test:memory-skill-learning','test:memory-skill-history','test:memory-skill-effectiveness','test:memory-skill-revision','test:memory-gateway','test:memory-gateway-controller','test:project-memory-agent','test:project-memory-extraction','test:project-memory-migration','test:memory-ui'],
  context: ['test:compaction','test:compaction-policy-history','test:prompt-context','test:runtime-skill-loader','test:runtime-materials','test:remote-access','test:pi-reasoning-stream'],
};
const selected = process.argv.slice(2);
const tests = selected.length ? selected.flatMap(s => groups[s] || [s]) : Object.values(groups).flat();
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
for (const name of tests) if (!pkg.scripts[name]) throw Error('Unknown script: '+name);
const out = path.join(root,'artifacts/pi-host-exit');
fs.mkdirSync(out,{recursive:true});
const label = selected.length === 1 && groups[selected[0]] ? selected[0] : 'regression';
const destination = path.join(out,label+'-results.json');
const auditBefore = JSON.parse(cp.execFileSync(process.execPath,['scripts/pi-host-boundary-audit.cjs'],{cwd:root,encoding:'utf8'}));
const report = { sourceFingerprint:auditBefore.sourceSha256,pid:process.pid, startedAt:new Date().toISOString(), status:'running', total:tests.length, tests:[] };
const save = () => { fs.writeFileSync(destination+'.tmp',JSON.stringify(report,null,2)); fs.renameSync(destination+'.tmp',destination); };
save();
for (const name of tests) {
  report.current = name; save();
  const started = Date.now(), log = name.replaceAll(':','-')+'.log';
  const fd = fs.openSync(path.join(out,log),'w');
  let result;
  try {
    result = cp.spawnSync(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash',
      ['--noprofile','--norc','-c','pnpm run '+name],
      {cwd:root,stdio:['ignore',fd,fd],windowsHide:true,timeout:150000});
  } finally { fs.closeSync(fd); }
  const row = {name,passed:result.status===0&&!result.error,exitCode:result.status,durationMs:Date.now()-started,log,...(result.error?{error:result.error.message}:{})};
  report.tests.push(row); save();
  console.log((row.passed?'PASS ':'FAIL ')+name+' '+row.durationMs+'ms');
  if (!row.passed) console.log(fs.readFileSync(path.join(out,log),'utf8').slice(-1200));
}
delete report.current;
const auditAfter=JSON.parse(cp.execFileSync(process.execPath,['scripts/pi-host-boundary-audit.cjs'],{cwd:root,encoding:'utf8'}));
report.sourceUnchanged=auditBefore.sourceSha256===auditAfter.sourceSha256;
report.status=report.tests.every(t=>t.passed)&&report.sourceUnchanged?'passed':'failed';
report.finishedAt=new Date().toISOString();save();
process.exitCode=report.status==='passed'?0:1;
