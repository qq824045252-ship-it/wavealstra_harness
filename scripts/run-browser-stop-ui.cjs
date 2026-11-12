const {build}=require('esbuild');const {writeFileSync,mkdirSync}=require('fs');const {spawnSync}=require('child_process');const {resolve}=require('path');
(async()=>{mkdirSync("out/tests",{recursive:true});
 for(const [entry,out,options] of [
  ['scripts/browser-stop-ui-electron-test.ts','browser-stop-ui-electron-test.mjs',{platform:'node',format:'esm',packages:'external'}],
  ['src/preload/index.ts','browser-stop-ui-preload.cjs',{platform:'node',format:'cjs',external:['electron']}],
  ['scripts/browser-stop-ui-fixture.tsx','browser-stop-ui-fixture.js',{platform:'browser',format:'iife',external:['@terrastruct/d2'],globalName:'BrowserStopUi',alias:{'@':resolve('src/renderer/src'),'@shared':resolve('src/shared')},loader:{'.css':'empty','.svg':'dataurl','.png':'dataurl'},jsx:'automatic'}],
 ]) {const result=await build({entryPoints:[entry],bundle:true,write:false,...options});writeFileSync('out/tests/'+out,result.outputFiles[0].contents);}
const run=spawnSync(require("electron"),["out/tests/browser-stop-ui-electron-test.mjs"],{stdio:"inherit",timeout:120000,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});if(run.error)throw run.error;if(run.status!==0)throw Error("UI stop test failed: "+run.status);})().catch(e=>{console.error(e);process.exitCode=1});


