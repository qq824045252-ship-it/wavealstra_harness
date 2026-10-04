import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, McpOAuthCredentialStore, InMemoryAuthStorageBackend } from '@earendil-works/pi-coding-agent';
import { McpRuntimeService } from '../src/main/mcp/McpRuntimeService';
import { McpConfigService } from '../src/main/mcp/McpConfigService';
import { toNativeMcpConfig } from '../src/main/mcp/NativeMcpConfig';
import { emptyMcpFilterResult, filterMcpConfigForMode } from '../src/main/mcp/McpModeFilter';
import { parseMcpToolIdentity, classifyMcpToolCall } from '../src/main/security/McpSideEffectPolicy';
import { createMcpSideEffectExtension } from '../src/main/agent/mcp-side-effect-extension';
import { createPermissionExtension } from '../src/main/agent/permission-extension';
import { mapPiEventToPatches } from '../src/shared/pi-event-mapper';
import { configurePiCodemodeAssets } from '../src/main/pi-codemode-assets';

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'mybuddy-pi099-integration-'));
const home = join(temporary, 'home'), workspace = join(temporary, 'workspace'), agentDir = join(home, '.mybuddy');
mkdirSync(workspace, { recursive: true }); mkdirSync(agentDir, { recursive: true });
const configPath = join(agentDir, 'mcp.json');
const server = { command: process.execPath, args: [resolve('scripts/pi099-workflow-server.mjs'), workspace, root], modes: ['coding'], timeout: 10 };
writeFileSync(configPath, JSON.stringify({ mcpServers: { fixture: server, designOnly: { ...server, modes: ['design'] } } }));
const configService = new McpConfigService({ homeDir: home, appGlobalPath: configPath });
const runtime = new McpRuntimeService({ agentDir, configService, credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()) });
const report: { startedAt: string; tests: Array<{ name: string; passed: boolean; details?: unknown; error?: string }>; finishedAt?: string } = { startedAt: new Date().toISOString(), tests: [] };
const reportPath = resolve('artifacts/pi099-migration/integration.json');
mkdirSync(resolve('artifacts/pi099-migration'), { recursive: true });
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try { const details = await fn(); report.tests.push({ name, passed: true, details }); console.log('PASS ' + name); }
  catch (error) { report.tests.push({ name, passed: false, error: error instanceof Error ? error.stack : String(error) }); console.error('FAIL ' + name + ': ' + String(error)); }
  save();
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, ms = 15000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error('Timed out waiting for native MCP'); await wait(30); } }
let mode: 'auto' | 'readonly' | 'default' = 'auto';
let approvals = 0;
// Deterministic model messages drive the real Agent loop. No SDK permission or call-origin checks are bypassed.
const model = { id:'mcp-fixture',provider:'fixture',api:'openai-completions',name:'Integration fixture',
  baseUrl:'http://invalid.invalid',reasoning:false,input:['text'],contextWindow:272000,maxTokens:4096,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
let desired: {id:string;name:string;args:unknown;issued:boolean;requests:number} | undefined;
const scriptedRuntime = {
  hasConfiguredAuth:()=>true, getAuth:async()=>({auth:{apiKey:'integration-fixture-only'}}),
  getModel:()=>model, getModels:()=>[model], getAvailable:()=>[model],
  getModelsOfType:(type:string)=>type==='chat'?[model]:[],
  getAvailableOfType:async(type:string)=>type==='chat'?[model]:[],
  getModelOfType:()=>undefined,
  streamSimple:()=>{
    if(!desired)throw Error('No scripted scenario');
    if(++desired.requests>3)throw Error('Unexpected integration Agent loop');
    const content=desired.issued?[{type:'text',text:'Integration scenario complete'}]:[{type:'toolCall',id:desired.id,name:desired.name,arguments:desired.args}];
    desired.issued=true;
    const stopReason=content[0].type==='toolCall'?'toolUse':'stop';
    const response:any={role:'assistant',content,stopReason,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
      usage:{input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const stream=createAssistantMessageEventStream();stream.push({type:'start',partial:response});
    stream.push({type:'done',reason:stopReason,message:response} as any);stream.end();return stream;
  },
};
const events: any[] = [];
const manager = SessionManager.create(workspace, join(agentDir, 'sessions'));
let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
try {
  await test('native-tool identities and exact server names', () => {
    for (const name of ['codemode', 'tool_search', 'list_mcp_resources', 'read_mcp_resource']) assert.equal(parseMcpToolIdentity(name), null);
    assert.deepEqual(parseMcpToolIdentity('mcp__team__erp__write_file', ['team__erp']), { providerId: 'team__erp', shortToolName: 'write_file' });
    assert.equal(parseMcpToolIdentity('mcp__drawio_ai__write_file', ['drawio-ai', 'drawio_ai'])?.providerId, 'drawio_ai');
    assert(classifyMcpToolCall('mcp__freecad__execute_python', {}, ['freecad'])?.dangerous);
    assert.deepEqual(parseMcpToolIdentity('mcp__drawio_ai_create_diagram', ['drawio-ai']), { providerId: 'drawio-ai', shortToolName: 'create_diagram' });
  });
  await test('configuration conversion: timeout, headers, disable and unsupported transports', () => {
    const converted = toNativeMcpConfig(emptyMcpFilterResult({ mcpServers: {
      env: { url: 'https://example.invalid/mcp', headers: { authorization: 'Bearer explicit', X_Test: '$env:TEST_TOKEN' }, bearerToken: 'must-not-overwrite', requestTimeoutMs: 2500 },
      disabled: { command: 'node', enabled: false },
      bad: { url: 'https://example.invalid/sse', type: 'sse' },
    } }));
    const entry = converted.servers.find(s => s.name === 'env')!;
    assert.equal(entry.config.timeout, 2.5);
    assert.equal((entry.config as any).headers.authorization, 'Bearer explicit');
    assert.equal((entry.config as any).headers.Authorization, undefined);
    assert.equal((entry.config as any).headers.X_Test, '${TEST_TOKEN}');
    assert.equal(converted.servers.find(s => s.name === 'disabled')!.config.enabled, false);
    assert.equal(converted.errors.length, 1);
    assert.deepEqual(filterMcpConfigForMode({ mcpServers: { disabled: { command: 'node', enabled: false } } }, 'coding').enabled, []);
    assert.equal(converted.servers.some(s => s.scope === 'extension'), false);
  });
  const settings = SettingsManager.inMemory({ defaultTools: ['+codemode', '+tool_search'], compaction:{enabled:false}, retry:{enabled:false,maxRetries:0} });
  const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    eventBus: runtime.createEventBus('task-fixture'),
    extensionFactories: [
      ...runtime.getInlineExtensions({ welcomeMode: 'coding', sessionLabel: 'task-fixture' }),
      createMcpSideEffectExtension({ taskId: 'task-fixture', taskRoot: workspace, providerIds: ['fixture'], getPermissionMode: () => mode, requestApproval: async () => { approvals++; return false; } }),
      createPermissionExtension({ getPermissionMode: () => mode, requestApproval: async () => { approvals++; return false; } }),
    ],
  });
  await loader.reload();
  const created = await createAgentSession({ cwd: workspace, agentDir, settingsManager: settings, sessionManager: manager, resourceLoader: loader, model:model as any, modelRuntime:scriptedRuntime as any });
  session = created.session;
  session.subscribe(event => events.push(event));
  runtime.attachSession('task-fixture', created.extensionsResult, ['fixture']);
  await session.bindExtensions({uiContext:runtime.getUiBridge(),mode:'rpc'});
  await until(() => runtime.getServerStatus('fixture', 'task-fixture')?.status === 'connected');
  const runner = session.extensionRunner!;
  async function invoke(id:string,name:string,args:unknown,signal?:AbortSignal) {
    desired={id,name,args,issued:false,requests:0};
    const aborted=()=>{void session!.abort();};
    if(signal?.aborted)throw Error('Already aborted');
    signal?.addEventListener('abort',aborted,{once:true});
    try {await session!.prompt('Run integration scenario '+id);}
    finally{signal?.removeEventListener('abort',aborted);}
    const result=session!.messages.find((m:any)=>m.role==='toolResult'&&m.toolCallId===id) as any;
    if(!result)throw Error('Missing authoritative tool result for '+id+'; '+session!.getLastAssistantText());
    return result;
  }
  async function code(id:string,body:string,signal?:AbortSignal){return invoke(id,'codemode',{code:body},signal);}
  function stored(key: string): any {
    for (const entry of [...manager.getEntries()].reverse() as any[]) if (entry.type === 'custom' && entry.customType === 'codemode-store' && Object.hasOwn(entry.data?.set ?? {}, key)) return entry.data.set[key];
    throw Error('Missing successful codemode store: ' + key);
  }
  await test('real repository inventory through native stdio and packaged QuickJS', async () => {
    assert.equal(configurePiCodemodeAssets(resolve('out/main')), true);
    const result = await code('inventory', `const r = await tools.mcp__fixture__get_source_inventory({}); const d=r.structuredContent; const summary={total:d.total,totalBytes:d.totalBytes,largest:d.files.sort((a,b)=>b.bytes-a.bytes).slice(0,3)}; store('inventory',summary); return summary;`);
    assert(!result.isError, JSON.stringify(result));
    let count = 0, bytes = 0;
    function walk(dir: string) { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(f); else if (/\.tsx?$/.test(e.name)) { count++; bytes += statSync(f).size; } } }
    walk(resolve('src'));
    assert.deepEqual({ total: stored('inventory').total, totalBytes: stored('inventory').totalBytes }, { total: count, totalBytes: bytes });
    assert(JSON.stringify(result.content).length < 3500, 'Intermediate source inventory leaked into outer result');
    return stored('inventory');
  });
  await test('native tool_search declares a deferred MCP tool and direct invocation succeeds', async () => {
    assert(!session!.getActiveToolNames().includes('mcp__fixture__get_metrics'));
    const found=await invoke('discover-metrics','tool_search',{query:'get_metrics',limit:1});
    assert(!found.isError,JSON.stringify(found));
    assert(session!.getActiveToolNames().includes('mcp__fixture__get_metrics'));
    const invoked=await invoke('discovered-metrics','mcp__fixture__get_metrics',{});
    assert(!invoked.isError,JSON.stringify(invoked));
    assert(events.some(e=>e.type==='tool_execution_end'&&e.toolCallId==='discovered-metrics'&&!e.isError));
  });
  await test('deferred MCP tool survives native reload and server reconnect', async () => {
    await session!.reload();
    const connected=await runtime.connect('fixture','task-fixture');assert(connected.ok,connected.error);
    const invoked=await invoke('metrics-after-reload','mcp__fixture__get_metrics',{});
    assert(!invoked.isError,JSON.stringify(invoked));
    assert(session!.getActiveToolNames().includes('mcp__fixture__get_metrics'));
  });
  await test('write then read a real temporary file', async () => {
    const result = await code('file-roundtrip', `await tools.mcp__fixture__write_file({path:'roundtrip.txt',text:'WaveAlstra native MCP ✓'}); const r=await tools.mcp__fixture__read_file({path:'roundtrip.txt'}); store('roundtrip',r.structuredContent); return r.structuredContent;`);
    assert(!result.isError, JSON.stringify(result));
    assert.equal(stored('roundtrip').text, readFileSync(join(workspace, 'roundtrip.txt'), 'utf8'));
  });
  await test('parallel native reads', async () => {
    const result = await code('parallel-read', `const r=await Promise.all([1,2,3].map(value=>tools.mcp__fixture__read_delay({value,delayMs:140}))); store('read-results',r.map(x=>x.structuredContent.value)); return r.map(x=>x.structuredContent.value);`);
    assert(!result.isError, JSON.stringify(result)); assert.deepEqual(stored('read-results'), [1,2,3]);
    await code('read-metrics', `const r=await tools.mcp__fixture__get_metrics({});store('read-metrics',r.structuredContent);return r.structuredContent;`);
    assert(stored('read-metrics').maxReads >= 2); return stored('read-metrics');
  });
  await test('concurrent write requests execute serially with no lost update', async () => {
    const result = await code('serial-write', `const r=await Promise.all([1,2,3].map(()=>tools.mcp__fixture__increment_counter({delayMs:90})));store('write-results',r.map(x=>x.structuredContent.value));return r.map(x=>x.structuredContent.value);`);
    assert(!result.isError, JSON.stringify(result)); assert.equal(JSON.parse(readFileSync(join(workspace, 'counter.json'), 'utf8')).value, 3);
    await code('write-metrics', `const r=await tools.mcp__fixture__get_metrics({});store('write-metrics',r.structuredContent);return r.structuredContent;`);
    assert.equal(stored('write-metrics').maxWrites, 1); return stored('write-metrics');
  });
  await test('readonly allows codemode inspection but rejects nested writes', async () => {
    mode = 'readonly'; const before = approvals;
    const read = await code('readonly-read', `const r=await tools.mcp__fixture__read_file({path:'roundtrip.txt'});return r.structuredContent;`);
    assert(!read.isError, JSON.stringify(read));
    const result = await code('readonly-write', `try {await tools.mcp__fixture__write_file({path:'must-not-exist.txt',text:'denied'});store('denial',{denied:false});}catch(e){store('denial',{denied:true,message:String(e)});}return load('denial');`);
    assert(!result.isError, JSON.stringify(result)); assert.equal(stored('denial').denied,true); assert(!existsSync(join(workspace,'must-not-exist.txt')));
    assert.equal(approvals,before,'Readonly inspection triggered unnecessary approval'); mode='auto';
  });
  await test('MCP isError preserved in script and direct child outcome', async () => {
    mode='auto';
    const result=await code('error-handling', `const r=await tools.mcp__fixture__report_failure({});store('failure',{isError:r.isError,code:r.structuredContent.code});return {handled:r.isError,code:r.structuredContent.code};`);
    assert(!result.isError,JSON.stringify(result)); assert.equal(stored('failure').isError,true); assert.equal(stored('failure').code,'EXPECTED_TEST_FAILURE');
    session!.setActiveToolsByName([...session!.getActiveToolNames(),'mcp__fixture__report_failure']);
    const direct=await invoke('direct-failure','mcp__fixture__report_failure',{});
    assert(direct.isError,JSON.stringify(direct));
    assert(events.some(e=>e.type==='tool_execution_end'&&e.toolName==='mcp__fixture__report_failure'&&e.isError));
  });
  await test('parent-child identity survives UI event mapping', () => {
    const child=events.find(e=>e.type==='tool_execution_start'&&e.parentToolCallId==='file-roundtrip'); assert(child);
    const patches=mapPiEventToPatches(child,{taskId:'fixture',messageId:'message',startedAt:Date.now()});
    assert.equal((patches[0] as any).parentToolCallId,'file-roundtrip');
    const ended=events.find(e=>e.type==='tool_execution_end'&&e.parentToolCallId==='file-roundtrip'); assert(ended);
    assert.equal((mapPiEventToPatches(ended,{taskId:'fixture',messageId:'message',startedAt:Date.now()})[0] as any).parentToolCallId,'file-roundtrip');
    return { parent: child.parentToolCallId, child: child.toolCallId };
  });
  await test('codemode state persists between successful invocations', async () => {
    await code('state-store', `store('state-check',{value:27});return {saved:true};`);
    await code('state-load', `store('state-loaded',load('state-check'));return load('state-check');`);
    assert.deepEqual(stored('state-loaded'),{value:27});
  });
  await test('cancellation prevents pending and queued writes from committing', async () => {
    const before=readFileSync(join(workspace,'counter.json'),'utf8');
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120);
    try { await code('cancel-writes',`await Promise.all([1,2,3].map(()=>tools.mcp__fixture__increment_counter({delayMs:1500})));return {done:true};`,controller.signal); } catch { /* Native tool may throw its cancellation error. */ } finally { clearTimeout(timer); }
    await wait(1750); assert.equal(readFileSync(join(workspace,'counter.json'),'utf8'),before);
    const cancelled=events.filter(e=>e.type==='tool_execution_end'&&e.parentToolCallId==='cancel-writes');
    assert(cancelled.length>0,'Cancellation did not exercise a real child call'); assert(cancelled.every(e=>e.isError));
    return { cancelledChildren: cancelled.length };
  });
  await test('manager and task status are native, separately scoped, and no fallback on missing tasks', async () => {
    const [a,b]=await Promise.all([runtime.ensureHeadlessSession(),runtime.ensureHeadlessSession()]);assert(a&&b);
    const connected=await runtime.connect('fixture');assert(connected.ok,connected.error);
    assert.equal(runtime.getStatus()?.runtime,'pi-native'); assert.equal(runtime.getStatus()?.sessionId,'mcp-headless');
    assert(runtime.getStatus()?.servers.some(s=>s.name==='designOnly'));
    assert(!runtime.getStatus('task-fixture')?.servers.some(s=>s.name==='designOnly'));
    assert.equal(runtime.getStatus('unknown-task'),null);
    assert.equal((await runtime.connect('designOnly','task-fixture')).ok,false);
    assert.equal((await runtime.connect('fixture','unknown-task')).ok,false);
  });
  await test('manager reconnect preserves native task operation', async () => {
    assert((await runtime.connect('fixture','task-fixture')).ok);
    const result=await code('after-reconnect',`const r=await tools.mcp__fixture__read_file({path:'roundtrip.txt'});store('after-reconnect',r.structuredContent);return r.structuredContent;`);
    assert(!result.isError,JSON.stringify(result));assert.equal(stored('after-reconnect').text,'WaveAlstra native MCP ✓');
  });
  await test('deferred MCP tool survives reopening an actual persisted Pi session', async () => {
    const saved=session!.sessionFile;assert(saved);
    await session!.extensionRunner?.emit({type:'session_shutdown',reason:'quit'});session!.dispose();
    const reopenedLoader=new DefaultResourceLoader({cwd:workspace,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:runtime.createEventBus('task-fixture'),extensionFactories:runtime.getInlineExtensions({welcomeMode:'coding',sessionLabel:'task-fixture'})});
    await reopenedLoader.reload();
    const reopened=await createAgentSession({cwd:workspace,agentDir,settingsManager:settings,sessionManager:SessionManager.open(saved),resourceLoader:reopenedLoader,model:model as any,modelRuntime:scriptedRuntime as any});
    session=reopened.session;runtime.attachSession('task-fixture',reopened.extensionsResult,['fixture']);await session.bindExtensions({uiContext:runtime.getUiBridge(),mode:'rpc'});
    const connected=await runtime.connect('fixture','task-fixture');assert(connected.ok,connected.error);
    const result=await invoke('metrics-after-resume','mcp__fixture__get_metrics',{});assert(!result.isError,JSON.stringify(result));assert(session.getActiveToolNames().includes('mcp__fixture__get_metrics'));
    return {reopened:true,nativeToolRestored:true};
  });
} catch(error) { report.tests.push({name:'integration setup',passed:false,error:error instanceof Error?error.stack:String(error)}); }
finally {
  if(session) { await session.extensionRunner?.emit({type:'session_shutdown',reason:'quit'});session.dispose(); }
  runtime.dispose(); await wait(200);
  rmSync(temporary,{recursive:true,force:true});
  report.finishedAt=new Date().toISOString();save();
  console.log(JSON.stringify({passed:report.tests.filter(t=>t.passed).length,failed:report.tests.filter(t=>!t.passed).length}));
  process.exitCode=report.tests.some(t=>!t.passed)?1:0;
}
