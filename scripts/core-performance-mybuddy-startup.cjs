const { existsSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const electronExe = require('electron');

function percentile(values, p) { const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.max(0,Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1))]||0; }
function summary(values){ return { p50:percentile(values,.5), p95:percentile(values,.95), min:Math.min(...values), max:Math.max(...values), n:values.length }; }
function runOnce(profile) {
  const main = join(process.cwd(), 'out', 'main', 'index.js');
  if (!existsSync(main)) throw new Error('out/main/index.js missing; run pnpm build first');
  const appData = join(profile, 'AppData', 'Roaming');
  const localAppData = join(profile, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true }); mkdirSync(localAppData, { recursive: true });
  const env = { ...process.env, MYBUDDY_PERF_STARTUP: '1', USERPROFILE: profile, HOME: profile, APPDATA: appData, LOCALAPPDATA: localAppData };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronExe, [main], { cwd: process.cwd(), env, encoding:'utf8', windowsHide:true, timeout:30000 });
  if (result.status !== 0) throw new Error(`full startup worker failed status=${result.status}\n${result.stdout}\n${result.stderr}`);
  const line = String(result.stdout).split(/\r?\n/).find((v)=>v.startsWith('MYBUDDY_PERF_STARTUP:'));
  if (!line) throw new Error('full startup marker missing:\n'+result.stdout+'\n'+result.stderr);
  return JSON.parse(line.slice('MYBUDDY_PERF_STARTUP:'.length)).processToRendererLoadedMs;
}

const cold=[];
for(let i=0;i<3;i++){
  const profile=mkdtempSync(join(tmpdir(),`mybuddy-full-start-cold-${i}-`));
  try{ cold.push(runOnce(profile)); } finally { rmSync(profile,{recursive:true,force:true}); }
}
const warmProfile=mkdtempSync(join(tmpdir(),'mybuddy-full-start-warm-'));
const warm=[];
try{
  runOnce(warmProfile); // materialize DB/settings/index state outside measured warm samples
  for(let i=0;i<5;i++) warm.push(runOnce(warmProfile));
} finally { rmSync(warmProfile,{recursive:true,force:true}); }
const report={ cold:summary(cold), warm:summary(warm) };
console.log('=== MyBuddy full startup performance ===');
console.log(`full-startup cold: p50=${report.cold.p50.toFixed(1)}ms p95=${report.cold.p95.toFixed(1)}ms n=${report.cold.n}`);
console.log(`full-startup warm: p50=${report.warm.p50.toFixed(1)}ms p95=${report.warm.p95.toFixed(1)}ms n=${report.warm.n}`);
console.log(JSON.stringify(report,null,2));
const budgets={cold:3500,warm:3000};
const failures=[];
for(const mode of ['cold','warm']){const ok=report[mode].p95<=budgets[mode]; console.log(`budget ${ok?'PASS':'FAIL'}: full-startup ${mode} p95=${report[mode].p95.toFixed(1)}ms <= ${budgets[mode]}ms`); if(!ok)failures.push(`${mode} ${report[mode].p95.toFixed(1)} > ${budgets[mode]}`);}
if(process.env.MYBUDDY_PERF_GATE==='1'&&failures.length) throw new Error('Full startup performance budget exceeded: '+failures.join('; '));