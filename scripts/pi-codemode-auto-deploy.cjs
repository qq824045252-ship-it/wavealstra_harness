/** Switch an idle desktop to the exact accepted portable. Never terminates an app with recorded live work. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const root=path.resolve(__dirname,'..');process.chdir(root);
const out=path.join(root,'artifacts/pi-codemode-auto');
const expectedPid=Number(process.argv[2]),expectedStart=Number(process.argv[3]);
assert(Number.isInteger(expectedPid)&&expectedPid>0&&Number.isFinite(expectedStart)&&expectedStart>1e12,'Provide the verified main process PID and creation timestamp');
const read=name=>JSON.parse(fs.readFileSync(path.join(out,name),'utf8'));
const live=read('desktop-live/results.json'),regression=read('regression-results.json'),build=JSON.parse(fs.readFileSync(read('build-latest.json').report,'utf8'));
assert.equal(live.status,'passed');assert.equal(live.tests.length,5);assert(live.tests.every(t=>t.status==='passed'));assert.equal(live.modeFallbackChecks.length,2);assert(live.modeFallbackChecks.every(t=>t.status==='passed'));
assert.equal(regression.status,'passed');assert(regression.sourceUnchanged);assert.equal(build.status,'passed');assert(build.sourceUnchanged);assert.equal(live.asarSha256,build.asarSha256);
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(build.asar)).digest('hex'),build.asarSha256);
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
const ps=code=>cp.execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:20000}).trim();
function processInfo(pid){const raw=ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($p){[pscustomobject]@{pid=$p.ProcessId;path=$p.ExecutablePath;startMs=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress}`);return raw?JSON.parse(raw):null;}
function assertOldProcess(){const p=processInfo(expectedPid);assert(p&&p.startMs===expectedStart&&/MyBuddy\.exe$/i.test(p.path),'Original process changed; do not terminate a different instance');return p;}
const home=path.join(os.homedir(),'.mybuddy'),dbPath=path.join(home,'app.db');
function idleCheck(){const db=new DatabaseSync(dbPath,{readOnly:true});try{const running=db.prepare("SELECT task_id,started_at FROM task_runtime_context_snapshots WHERE status='running' AND started_at>=?").all(expectedStart);const leases=db.prepare('SELECT task_id,expires_at FROM task_run_leases WHERE expires_at>?').all(Date.now());assert.equal(running.length,0,'Recorded active user tasks remain');assert.equal(leases.length,0,'Unexpired user task leases remain');return {at:new Date().toISOString(),runningSinceStart:running,unexpiredLeases:leases};}finally{db.close();}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function health(){try{return (await fetch('http://127.0.0.1:3352/healthz',{signal:AbortSignal.timeout(1500)})).status}catch{return null}}
const report={at:new Date().toISOString(),status:'preparing',runningInstanceChanged:false,executable:build.executable,asarSha256:build.asarSha256};const save=()=>fs.writeFileSync(path.join(out,'deployment.json'),JSON.stringify(report,null,2));
(async()=>{try{
  report.previousProcess=assertOldProcess();report.beforeBackup=idleCheck();report.previousRemoteHealth=await health();save();
  const folder=path.join(home,'backups','pi-codemode-auto-'+new Date().toISOString().replace(/\D/g,''));fs.mkdirSync(folder,{recursive:true});const destination=path.join(folder,'app.db');
  const source=new DatabaseSync(dbPath,{readOnly:true});try{await backup(source,destination)}finally{source.close()}
  const checked=new DatabaseSync(destination,{readOnly:true});try{assert.equal(checked.prepare('PRAGMA quick_check').get().quick_check,'ok')}finally{checked.close()}
  for(const name of ['settings.json','mcp.json'])if(fs.existsSync(path.join(home,name)))fs.copyFileSync(path.join(home,name),path.join(folder,name));
  report.backup=destination;report.beforeClose=idleCheck();assertOldProcess();save();
  // Ask the window to close first. Close-to-tray may intentionally leave the idle process alive.
  ps(`$p=Get-Process -Id ${expectedPid} -ErrorAction Stop;$null=$p.CloseMainWindow()`);await wait(800);
  if(processInfo(expectedPid)){assertOldProcess();report.beforeTerminate=idleCheck();cp.execFileSync('C:/Windows/System32/taskkill.exe',['/PID',String(expectedPid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:10000});}
  for(let i=0;i<30&&processInfo(expectedPid);i++)await wait(100);assert.equal(processInfo(expectedPid),null,'Original process did not stop');
  const child=cp.spawn(build.executable,[],{cwd:path.dirname(build.executable),detached:true,stdio:'ignore',windowsHide:false});child.unref();report.newPid=child.pid;
  let current;for(let i=0;i<60;i++){await wait(250);current=processInfo(child.pid);if(current?.path?.toLowerCase()===build.executable.toLowerCase())break;}assert(current,'Accepted desktop did not start');assert.equal(current.path.toLowerCase(),build.executable.toLowerCase());report.currentProcess=current;
  const shortcut=ps(`$w=New-Object -ComObject WScript.Shell;$items=@(Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Filter '*MyBuddy*.lnk');if($items.Count -ne 1){throw 'Expected one existing MyBuddy shortcut'};$f=$items[0].FullName;Copy-Item -LiteralPath $f -Destination ${quote(path.join(folder,'MyBuddy-before.lnk'))};$s=$w.CreateShortcut($f);$s.TargetPath=${quote(build.executable)};$s.WorkingDirectory=${quote(path.dirname(build.executable))};$s.IconLocation=${quote(build.executable+',0')};$s.Save();$f`);report.shortcut=shortcut;
  for(let i=0;i<40;i++){report.remoteHealth=await health();if(report.remoteHealth===200||report.previousRemoteHealth!==200)break;await wait(300)}
  if(report.previousRemoteHealth===200)assert.equal(report.remoteHealth,200,'Previously available remote endpoint did not recover');
  report.status='deployed';report.runningInstanceChanged=true;report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(report,null,2));
}catch(error){report.status='failed';report.error=String(error);report.finishedAt=new Date().toISOString();save();console.error(JSON.stringify(report,null,2));process.exitCode=1}})();
