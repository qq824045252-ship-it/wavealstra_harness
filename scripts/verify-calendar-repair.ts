import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Script } from 'node:vm';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { GadgetStorage } from '../src/main/gadget/GadgetStorage';
import { GadgetRegistry } from '../src/main/gadget/GadgetRegistry';
import { GadgetRuntime } from '../src/main/gadget/GadgetRuntime';
import { GadgetService } from '../src/main/gadget/GadgetService';
import { GadgetRepository } from '../src/main/gadget/GadgetRepository';
import { createGadgetAgentExtension } from '../src/main/gadget/gadget-agent-extension';
import type { GadgetSourceSnapshot, GadgetSourceUpdateRequest } from '../src/shared/gadget-types';

const id=process.argv[2];if(!/^gdt-[a-zA-Z0-9-]+$/.test(id||''))throw Error('Pass a prepared Gadget ID');
const output=path.join(process.cwd(),'out/diagnostics/calendar-sync-repair',id);
const patch=JSON.parse(fs.readFileSync(path.join(output,'patch.json'),'utf8')) as GadgetSourceUpdateRequest;
const before=JSON.parse(fs.readFileSync(path.join(output,`source-before-${patch.expectedRevision}.json`),'utf8')) as GadgetSourceSnapshot;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'calendar-real-tools-'));
const db=new AppDatabase(':memory:');db.upsertTask({id:'fixture',title:'calendar tools',updatedAt:Date.now()});
const storage=new GadgetStorage(path.join(root,'gadgets')),registry=new GadgetRegistry(),runtime=new GadgetRuntime(storage,registry);
const service=new GadgetService({repository:new GadgetRepository(db.connection),storage,registry,runtime,
  taskExists:id=>id==='fixture',taskWorkspaceId:()=>null,workspaceExists:()=>false,workspaceEffectiveArchived:()=>false,workspaceAncestors:()=>[]});
type Tool={name:string;execute:(id:string,input:never)=>Promise<{isError?:boolean;content:{text?:string}[];details?:unknown}>};
const tools:Tool[]=[];
createGadgetAgentExtension({taskId:'fixture',service,resolveWorkspaceId:()=>null,getPermissionMode:()=> 'auto',requestApproval:async()=>true})(
  {registerTool:(tool:never)=>tools.push(tool)} as unknown as ExtensionAPI);
const execute=async(name:string,input:object)=>{const tool=tools.find(tool=>tool.name===name);assert(tool);return tool.execute(name,input as never)};
async function main(){try {
  const gadget=service.create({name:before.manifest.name,scope:{type:'task',taskId:'fixture'},entry:before.manifest.entry,
    files:before.files,defaultConfig:before.manifest.defaultConfig,backend:before.manifest.backend});
  let cursor:string|undefined,revision:string|undefined,joined='',pages=0;
  do {
    const read=await execute('gadget_read',{gadgetId:gadget.id,path:before.manifest.entry,maxBytes:2000,...(cursor?{cursor}:{})});
    assert.equal(read.isError,undefined,JSON.stringify(read));
    const text=read.content[0].text!;assert(Buffer.byteLength(text)<=2000);
    const page=JSON.parse(text);assert.equal(page.revision,(read.details as {revision:string}).revision);
    revision??=page.revision;assert.equal(page.revision,revision);joined+=page.chunk;cursor=page.nextCursor;pages++;
  }while(cursor);
  assert.equal(joined,before.files.find(file=>file.path===before.manifest.entry)?.content);assert(pages>1);
  const opened=await service.start(gadget.id);assert.equal(opened.status,'running',opened.error);
  const updated=await execute('gadget_update',{...patch,gadgetId:gadget.id,expectedRevision:revision});
  assert.equal(updated.isError,undefined,JSON.stringify(updated));
  const state=await service.health(gadget.id);assert.equal(state.status,'running',state.error);assert.notEqual(state.pid,opened.pid);
  const generated=await import(pathToFileURL(path.join(gadget.sourcePath,'server/commands.mjs')).href);
  const commandRunner=generated.createGadgetCommandRunner({platform:process.platform,cwd:gadget.sourcePath,allowedCommands:['node'],environment:{...process.env},nodeExecutable:process.execPath});
  try { assert.equal((await commandRunner.run('node',{args:['-e','process.stdout.write("native-module-ok")']})).stdout,'native-module-ok'); }
  finally { await commandRunner.dispose(); }
  const loaded=await execute('gadget_call',{gadgetId:gadget.id,action:'calendar.read'});
  assert.equal(loaded.isError,undefined,JSON.stringify(loaded));
  const previous=JSON.parse(before.files.find(file=>file.path==='data.json')!.content);
  const value=(loaded.details as {value:{tasks:unknown[];notes:unknown[];events:unknown[]}}).value;
  assert.deepEqual(value.tasks,previous.tasks);assert.deepEqual(value.notes,previous.notes);
  const conflict=await execute('gadget_update',{...patch,gadgetId:gadget.id,expectedRevision:revision});assert.equal(conflict.isError,true);
  const html=service.readSource(gadget.id).files.find(file=>file.path===before.manifest.entry)!.content;
  const script=/<script>([\s\S]*?)<\/script>/i.exec(html)?.[1];assert(script);new Script(script);
  const receipt={passed:true,pages,originalBytes:Buffer.byteLength(joined),nativeToolSequence:['gadget_read','gadget_update','gadget_call'],
    revision,updatedRevision:(updated.details as {revision:string}).revision,sourceFiles:service.readSource(gadget.id).files.map(file=>file.path),
    beforePid:opened.pid,afterPid:state.pid,preservedTasks:value.tasks.length,preservedNotes:value.notes.length,conflictRejected:true};
  fs.writeFileSync(path.join(output,'tool-verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
} finally{await runtime.disposeAll();db.close();fs.rmSync(root,{recursive:true,force:true})}}
void main().catch(error=>{console.error(error);process.exitCode=1});
