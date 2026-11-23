import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { currentPlatformId } from "../src/main/platform";
import { mapVerifiedBashWorkspacePath, withWindowsBashWorkspacePath } from "../src/main/platform/bash-workspace-path";
import { createDurableArtifactRegistrationTool } from "../src/main/agent/durable/DurableArtifactRegistration";
import { DurableExecutionEnv } from "../src/main/agent/durable/DurableExecutionEnv";

const env = new DurableExecutionEnv({ cwd: process.cwd() });
const originalTimeout = globalThis.setTimeout;
try {
  // Use the real shell and native cancellation, with a short silence window for this fixture.
  globalThis.setTimeout = ((callback, ms, ...args) =>
    originalTimeout(callback, ms === 120_000 ? 900 : ms, ...args)) as typeof setTimeout;
  let progress = "";
  const speaking = await env.exec("for i in 1 2 3 4; do echo progress-$i >&2; sleep 0.35; done",
    { onOutput: chunk => { progress += chunk; } }, ctx);
  assert(speaking.ok);
  assert.equal(speaking.value.exitCode, 0);
  assert.deepEqual(progress.trim().split(/\r?\n/u), ["progress-1", "progress-2", "progress-3", "progress-4"]);

  let pidText = "";
  const silent = await env.exec("node -e 'console.log(process.pid); setTimeout(() => {}, 15000)'",
    { onOutput: chunk => { pidText += chunk; } }, ctx);
  assert(!silent.ok);
  assert.equal(silent.error.message, "Bash produced no stdout or stderr for 120 seconds");
  const pid = Number(pidText.trim());
  assert(Number.isSafeInteger(pid) && pid > 0);
  const childLives = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const cleanupDeadline = Date.now() + 4_000;
  while (childLives() && Date.now() < cleanupDeadline) await delay(40);
  assert.equal(childLives(), false, "the real process tree is terminated after the failure");

  let totalOutput = "";
  const total = await env.exec("while true; do echo progress; sleep 0.15; done",
    { timeout: 0.6, onOutput: chunk => { totalOutput += chunk; } }, ctx);
  assert(!total.ok);
  assert.equal(total.error.code, "timeout");
  assert.match(totalOutput, /progress/u);
  const direct = await env.exec([process.execPath, "-e", "setTimeout(() => {}, 1300)"], undefined, ctx);
  assert(direct.ok);
  assert.equal(direct.value.exitCode, 0);
  console.log("PASS Bash stderr refreshes the deadline, silence fails and kills the process tree, total timeout and argv execution stay independent");
} finally {
  globalThis.setTimeout = originalTimeout;
  await env.cleanup(ctx);
}

assert.equal(mapVerifiedBashWorkspacePath('/tmp/work/a.txt','C:\\Temp\\work','/tmp/work','C:/Temp/work'),'C:\\Temp\\work\\a.txt');
for (const p of ['/tmp/work-other/a','/tmp/work/../outside','/etc/passwd','/tmp/work/C:/outside']) assert.throws(()=>mapVerifiedBashWorkspacePath(p,'C:\\Temp\\work','/tmp/work','C:/Temp/work'));
assert.throws(()=>mapVerifiedBashWorkspacePath('/tmp/work/a','D:\\work','/tmp/work','C:/Temp/work'));
const passthrough: any = {name:'write',execute:async (args:unknown)=>args};
assert.strictEqual(withWindowsBashWorkspacePath(passthrough,'linux'),passthrough);
assert.strictEqual(withWindowsBashWorkspacePath(passthrough,'macos'),passthrough);
for(const path of ['C:/tmp/a','D:\\a','//server/share/a','relative/a','../other','file:///C:/a']) assert.deepEqual(await withWindowsBashWorkspacePath(passthrough,'windows').execute({path} as any,{} as any,ctx),{path});
if(currentPlatformId !== 'windows') { console.log('PASS pure mapping boundaries; Windows Git Bash integration not run on this platform'); }
else {
 const root=await mkdtemp(join(tmpdir(),'bash-native-path-')),cwd=join(root,'workspace'); await mkdir(cwd);
 const env=new NodeExecutionEnv({cwd});
 try {
  let alias=''; const probe=await env.exec('pwd',{onOutput:text=>{alias+=text}},ctx); assert(probe.ok&&probe.value.exitCode===0);alias=alias.trim();
  const before=await env.absolutePath(alias+'/roundtrip.txt',ctx);assert(before.ok);assert.notEqual(before.value,join(cwd,'roundtrip.txt'),'reproduce original native resolution mismatch');
  const api:any={env,output:()=>{}};
  const native=(name:string)=>CodingTools.tools!.find(t=>t.name===name)!;
  await withWindowsBashWorkspacePath(native('write')).execute({path:alias+'/roundtrip.txt',content:'first'} as any,api,ctx);
  assert.equal(await readFile(join(cwd,'roundtrip.txt'),'utf8'),'first');
  let shell='';const check=await env.exec('cat roundtrip.txt',{onOutput:text=>{shell+=text}},ctx);assert(check.ok&&check.value.exitCode===0);assert.equal(shell,'first');
  await withWindowsBashWorkspacePath(native('edit')).execute({path:alias+'/roundtrip.txt',edits:[{oldText:'first',newText:'second'}]} as any,api,ctx);
  const read=await withWindowsBashWorkspacePath(native('read')).execute({path:alias+'/roundtrip.txt'} as any,api,ctx);assert(JSON.stringify(read).includes('second'));
  const atRead=await withWindowsBashWorkspacePath(native('read')).execute({path:'@'+alias+'/roundtrip.txt'} as any,api,ctx);assert(JSON.stringify(atRead).includes('second'));
  const entries:any[]=[];Object.assign(api,{conversationId:1,callId:'register-path',taskId:1,agent:async()=>({cwd}),snapshot:async()=>({run:{inputs:[1]}}),commit:async(fn:any)=>fn({task:async()=>undefined,conversation:async()=>({}),scanEntries:async()=>({items:[]}),appendEntry:async(_:any,conversationId:number,value:any)=>{const entry={id:1,conversationId,...value};entries.push(entry);return entry;}})});
  const registered=await withWindowsBashWorkspacePath(createDurableArtifactRegistrationTool(join(root,'store'))).execute({path:alias+'/roundtrip.txt'} as any,api,ctx);assert(!registered.isError,JSON.stringify(registered));assert.equal(entries.length,1);assert.equal(entries[0].data.path,join(cwd,'roundtrip.txt'));
  const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'keep.txt'),'keep');await symlink(outside,join(cwd,'escape'),'junction');
  await assert.rejects(withWindowsBashWorkspacePath(native('write')).execute({path:alias+'/escape/new.txt',content:'bad'} as any,api,ctx),/symlink/);
  await assert.rejects(withWindowsBashWorkspacePath(native('write')).execute({path:alias+'/../outside/keep.txt',content:'bad'} as any,api,ctx),/escapes/);assert.equal(await readFile(join(outside,'keep.txt'),'utf8'),'keep');
  const literal="quote';touch PWNED;'.txt";await withWindowsBashWorkspacePath(native('write')).execute({path:alias+'/'+literal,content:'literal'} as any,api,ctx);assert.equal(await readFile(join(cwd,literal),'utf8'),'literal');await assert.rejects(readFile(join(cwd,'PWNED')));
  await assert.rejects(withWindowsBashWorkspacePath(native('write')).execute({path:'/etc/ambiguous',content:'bad'} as any,api,ctx),/outside/);
  await assert.rejects(withWindowsBashWorkspacePath(native('write')).execute({path:alias+'/x',content:'bad'} as any,{env:{cwd,exec:async()=>({ok:true,value:{exitCode:1}})}} as any,ctx),/Cannot verify/);
  console.log('PASS real Git Bash/native write-edit-read and register_artifact; traversal, prefix, junction, shell metacharacters, failed mapping, native/UNC/relative and non-Windows preservation');
 } finally {await env.cleanup(ctx);await rm(root,{recursive:true,force:true});}
}
