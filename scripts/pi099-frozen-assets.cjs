/** Execute the native Worker/WASM from the immutable verified distribution. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const distribution=JSON.parse(fs.readFileSync('artifacts/pi099-migration/frozen/distribution.json','utf8'));
const env={...process.env,MYBUDDY_PACKAGE_DIR:distribution.destination};delete env.ELECTRON_RUN_AS_NODE;
const child=cp.spawn(process.execPath,['node_modules/electron/cli.js','out/tests/pi099-packaged-assets-electron.mjs'],{cwd:root,env,stdio:'inherit',windowsHide:true});
let finished=false;const timer=setTimeout(()=>{if(!finished)cp.spawn('C:/Windows/System32/taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});},60000);
child.once('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
child.once('exit',(code,signal)=>{
 finished=true;clearTimeout(timer);
 if(code===0&&!signal){
  const report=JSON.parse(fs.readFileSync('artifacts/pi099-migration/packaged-assets.json','utf8'));
  if(!report.passed)throw Error('Packaged assets test did not pass');
  report.distribution=distribution.destination;
  fs.writeFileSync('artifacts/pi099-migration/frozen/packaged-assets.json',JSON.stringify(report,null,2));
 }
 process.exitCode=code===0&&!signal?0:1;
});
