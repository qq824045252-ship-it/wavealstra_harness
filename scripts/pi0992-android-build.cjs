const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');process.chdir(root);const out=path.join(root,'artifacts/pi0992-memory/android');fs.mkdirSync(out,{recursive:true});
const report={startedAt:new Date().toISOString(),pid:process.pid,status:'running',steps:[]};const save=()=>fs.writeFileSync(path.join(out,'build-results.json'),JSON.stringify(report,null,2));
function run(name,command,cwd=root,timeout=180000){const fd=fs.openSync(path.join(out,name+'.log'),'w');const r=cp.spawnSync('cmd.exe',['/d','/s','/c',command],{cwd,windowsHide:true,timeout,stdio:['ignore',fd,fd]});fs.closeSync(fd);report.steps.push({name,exitCode:r.status,error:r.error?.message,passed:r.status===0});save();if(r.status!==0)throw Error(name+' failed; see log');}
try{
 let s=fs.readFileSync(path.join(root,'scripts/remote-renderer-regression-test.cjs'),'utf8').replaceAll('artifacts/remote-android-20260930','artifacts/pi0992-memory/android/renderer');
 fs.writeFileSync(path.join(root,'scripts/pi0992-remote-renderer-test.cjs'),s);
 run('renderer','node scripts/pi0992-remote-renderer-test.cjs');
 run('sync','pnpm run remote:android:sync');
 run('gradle','gradlew.bat assembleDebug --console=plain',path.join(root,'app/remote/android'),300000);
 const apk=path.join(root,'app/remote/android/app/build/outputs/apk/debug/app-debug.apk');if(!fs.existsSync(apk))throw Error('APK missing');
 const target=path.join(out,'MyBuddy-Remote-1.1.8-pi0992.apk');fs.copyFileSync(apk,target);report.apk=target;report.sha256=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
 const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');const devices=cp.spawnSync(adb,['devices','-l'],{encoding:'utf8',windowsHide:true,timeout:10000});report.adbDevices=devices.stdout;report.deviceAvailable=/^\S+\s+device\s/m.test(devices.stdout||'');
 report.status='passed';
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1;}finally{report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(report,null,2));}
