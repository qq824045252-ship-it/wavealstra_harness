import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryAuthStorageBackend, McpOAuthCredentialStore } from '@earendil-works/pi-coding-agent';
import { McpRuntimeService } from '../src/main/mcp/McpRuntimeService';
import { McpConfigService } from '../src/main/mcp/McpConfigService';
import { toNativeMcpConfig } from '../src/main/mcp/NativeMcpConfig';
import { emptyMcpFilterResult } from '../src/main/mcp/McpModeFilter';

const root=mkdtempSync(join(tmpdir(),'pi099-manager-lifecycle-'));
const dir=resolve('artifacts/pi099-closeout');mkdirSync(dir,{recursive:true});
const report:{startedAt:string;tests:Array<{name:string;passed:boolean;error?:string}>;finishedAt?:string}={startedAt:new Date().toISOString(),tests:[]};
async function test(name:string,fn:()=>Promise<void>|void){try{await fn();report.tests.push({name,passed:true});console.log('PASS '+name);}catch(e){report.tests.push({name,passed:false,error:e instanceof Error?e.message:String(e)});console.error('FAIL '+name+': '+String(e));}}
function service(){return new McpRuntimeService({agentDir:root,configService:new McpConfigService({homeDir:root,appGlobalPath:join(root,'mcp.json')}),credentials:new McpOAuthCredentialStore(new InMemoryAuthStorageBackend())});}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
try {
 await test('duplicate sign-in requests share an in-flight exclusion before manager readiness',async()=>{
  const runtime=service();const ready=deferred<any>();let signIns=0;
  (runtime as any).controller=()=>ready.promise;
  const first=runtime.authStart('server'),second=runtime.authStart('server');
  ready.resolve({signIn:async()=>{signIns++;}});
  const results=await Promise.all([first,second]);runtime.dispose();
  assert.equal(signIns,1,'Concurrent requests started two OAuth flows');
  assert.equal(results.filter(r=>r.ok).length,1);
 });
 await test('dispose during manager readiness prevents a late authorization flow',async()=>{
  const runtime=service();const ready=deferred<any>();let signIns=0;
  (runtime as any).controller=()=>ready.promise;
  const started=runtime.authStart('server');runtime.dispose();ready.resolve({signIn:async()=>{signIns++;}});
  const result=await started;
  assert.equal(signIns,0,'Authorization started after the runtime was disposed');assert.equal(result.ok,false);
 });
 await test('invalid native configuration never silently becomes a valid transport',()=>{
  const result=toNativeMcpConfig(emptyMcpFilterResult({mcpServers:{
   badType:{type:'websocket',url:'https://example.invalid/mcp'},
   badCwd:{command:'node',cwd:42},
   badOauth:{url:'https://example.invalid/mcp',oauth:[]},
   badTools:{command:'node',directTools:[42]},
   good:{command:'node',args:['server.js'],enabled:false},
  }} as any));
  assert.deepEqual(result.servers.map(s=>s.name),['good']);assert.equal(result.errors.length,4);
 });
 await test('Office/headless managers expose native discovery without enabling Code Mode',async()=>{
  const runtime=service();let definition:any;
  const factory=runtime.getInlineExtensions({sessionLabel:'scope-proof'})[0];
  assert.equal(typeof factory,'function');
  await (factory as any)({registerTool:(tool:any)=>{definition=tool;},getSettings:()=>({}),getAllTools:()=>[]});
  assert(definition);assert.equal(definition.name,'tool_search');
  runtime.dispose();
 });
} finally {
 rmSync(root,{recursive:true,force:true});report.finishedAt=new Date().toISOString();writeFileSync(join(dir,'manager-lifecycle.json'),JSON.stringify(report,null,2));
 process.exitCode=report.tests.some(t=>!t.passed)?1:0;
}
