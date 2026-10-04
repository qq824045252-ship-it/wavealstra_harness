import assert from 'node:assert/strict';
import { app } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { configurePiCodemodeAssets } from '../src/main/pi-codemode-assets';

async function main(): Promise<void> {
  await app.whenReady();
  const temp=mkdtempSync(join(tmpdir(),'pi099-packaged-assets-'));
  const logicalRoot=resolve(process.env.MYBUDDY_PACKAGE_DIR ?? 'release-pi099-closeout/win-unpacked', 'resources/app.asar/out/main');
  const report:any={startedAt:new Date().toISOString(),passed:false,kind:'real Electron loading assets from the generated distribution'};
  let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
  try {
    assert(existsSync(join(logicalRoot,'index.js')),'Packaged application entry is missing');
    assert(configurePiCodemodeAssets(logicalRoot),'Packaged worker/WASM configuration failed');
    const settings=SettingsManager.inMemory({defaultTools:['+codemode']});
    const loader=new DefaultResourceLoader({cwd:temp,agentDir:temp,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[createCodemodeExtension({mode:'on'})]});
    await loader.reload();session=(await createAgentSession({cwd:temp,agentDir:temp,settingsManager:settings,sessionManager:SessionManager.inMemory(temp),resourceLoader:loader})).session;
    await session.bindExtensions({});
    const result:any=await session.getToolDefinition('codemode')!.execute('package-asset-check',{code:'return { answer: 6 * 7, sandbox: typeof process };'},undefined,undefined,session.extensionRunner!.createToolContext('package-asset-check',undefined));
    assert(!result.isError,JSON.stringify(result));const text=result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');assert.match(text,/42/);assert.match(text,/undefined/);
    Object.assign(report,{passed:true,asarEntryPresent:true,workerAndWasmLoaded:true,result:text});console.log('PASS packaged app.asar.unpacked Worker + WASM executed through native Codemode in real Electron');
  }catch(error){report.error=String(error);console.error(report.error);}
  finally{if(session){await session.extensionRunner?.emit({type:'session_shutdown',reason:'quit'});session.dispose();}rmSync(temp,{recursive:true,force:true});report.finishedAt=new Date().toISOString();mkdirSync(resolve('artifacts/pi099-migration'),{recursive:true});writeFileSync(resolve('artifacts/pi099-migration/packaged-assets.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1);}
}
void main().catch(error=>{console.error(error);app.exit(1);});
