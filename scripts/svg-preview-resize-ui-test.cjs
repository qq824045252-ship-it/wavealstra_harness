const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),os=require('node:os');
const output=path.join(process.cwd(),'out/tests/streaming-live');fs.mkdirSync(output,{recursive:true});
async function worker(){
 const {app,BrowserWindow}=require('electron');app.setPath('userData',process.argv[process.argv.indexOf('--profile')+1]);
 app.commandLine.appendSwitch('disable-background-timer-throttling');await app.whenReady();
 const win=new BrowserWindow({show:true,width:1000,height:760,webPreferences:{backgroundThrottling:false}});
 try{
  await win.loadFile(path.join(process.cwd(),'out/tests/svg-preview-resize-ui.html'));
  const result=await win.webContents.executeJavaScript('window.runResizeTest()',true);
  fs.writeFileSync(path.join(output,'svg-resize-ui.json'),JSON.stringify(result,null,2));
  assert.deepEqual(result.errors,[],'ResizeObserver errors are test failures');assert.equal(result.cases.length,2);
  for(const c of result.cases){assert(c.stable,c.name+' did not settle');assert(c.heights.every(h=>Number.isFinite(h)&&h>80&&h<800),c.name+' produced invalid heights');}
  assert(Math.max(...result.cases[0].heights)-Math.min(...result.cases[0].heights)>80,'Intrinsic preview must follow container width');
  assert(Math.max(...result.cases[1].heights)-Math.min(...result.cases[1].heights)<2,'Fixed CSS height must not oscillate');
  assert.equal(result.unmounted,true);console.log('PASS svg-preview-resize: 40 width changes, intrinsic + DOM fallback, stable height, no browser errors, cleanup');
 }catch(e){console.error(e);process.exitCode=1;}finally{win.destroy();app.exit(process.exitCode||0);}
}
if(process.argv.includes('--worker'))worker().catch(e=>{console.error(e);process.exitCode=1});
else{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'mybuddy-resize-ui-test-'));
 try{
  fs.writeFileSync('out/tests/svg-preview-resize-ui.html','<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="svg-preview-resize-ui.css"></head><body><div id="root"></div><script src="svg-preview-resize-ui.js"></script></body></html>');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=cp.spawnSync(require('electron'),[__filename,'--worker','--profile',profile],{env,cwd:process.cwd(),encoding:'utf8',timeout:20000,windowsHide:true});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.error)console.error(result.error);process.exitCode=result.status??1;
 }finally{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
