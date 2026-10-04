import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, InMemoryAuthStorageBackend, McpOAuthCredentialStore } from '@earendil-works/pi-coding-agent';
import { registerMyBuddyProviders } from '../src/main/agent/providers';
import { McpRuntimeService } from '../src/main/mcp/McpRuntimeService';
import { McpConfigService } from '../src/main/mcp/McpConfigService';
import { createMcpSideEffectExtension } from '../src/main/agent/mcp-side-effect-extension';
import { configurePiCodemodeAssets } from '../src/main/pi-codemode-assets';

const root = process.cwd(), actualHome = join(homedir(), '.mybuddy');
const temp = mkdtempSync(join(tmpdir(), 'mybuddy-pi099-live-'));
const home = join(temp, 'home'), agentDir = join(home, '.mybuddy'), workspace = join(temp, 'workspace');
mkdirSync(agentDir, { recursive: true }); mkdirSync(workspace, { recursive: true });
const report: any = { startedAt: new Date().toISOString(), tests: [], kind: 'real-provider-native-MCP' };
const output = resolve('artifacts/pi099-migration/live-tasks.json');mkdirSync(resolve('artifacts/pi099-migration'), { recursive: true });
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
let service: McpRuntimeService | undefined;
try {
  assert(configurePiCodemodeAssets(resolve('out/main')));
  // Credential values never enter logs or test artifacts; use the user's existing authorized runtime.
  if (existsSync(join(actualHome, 'models-store.json'))) copyFileSync(join(actualHome, 'models-store.json'), join(agentDir, 'models-store.json'));
  const modelRuntime = await ModelRuntime.create({ authPath: join(actualHome, 'auth.json'),
    modelsPath: join(actualHome, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'),
    allowModelNetwork: false, refreshOnCreate: false });
  registerMyBuddyProviders(modelRuntime);await modelRuntime.refresh({ allowNetwork: false });
  const model = modelRuntime.getModel('commandcode', 'deepseek/deepseek-v4.1-flash');
  if (!model) throw Error('Previously verified configured real model is unavailable');
  if (!await modelRuntime.hasConfiguredAuth(model.provider)) throw Error('Configured model credentials unavailable');
  report.model = model.provider + '/' + model.id;
  const configPath = join(agentDir, 'mcp.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { fixture: { command: process.execPath,
    args: [resolve('scripts/pi099-workflow-server.mjs'), workspace, root], exposure: 'codemode', timeout: 15 } } }));
  const configService = new McpConfigService({ homeDir: home, appGlobalPath: configPath });
  service = new McpRuntimeService({ agentDir, configService, credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()) });
  const cases = [
    { id: 'inventory', prompt: '使用 codemode 和 fixture MCP 工具读取真实项目的 TypeScript 文件清单。按 bytes 从大到小计算文件数量 total、总字节 totalBytes 和最大的 3 个文件 largest。用 fixture write_file 把 JSON 结果保存为 inventory-summary.json，再用 fixture read_file 回读验证。主回答只总结结果。必须真正调用工具，不能猜测。', check: () => {
      const result = JSON.parse(readFileSync(join(workspace, 'inventory-summary.json'), 'utf8'));
      let count=0,bytes=0;const walk=(dir:string)=>{for(const e of readdirSync(dir,{withFileTypes:true})){const f=join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(f);else if(/\.tsx?$/.test(e.name)){count++;bytes+=statSync(f).size;}}};walk(resolve('src'));
      assert.equal(result.total,count);assert.equal(result.totalBytes,bytes);assert.equal(result.largest.length,3);return {total:count,totalBytes:bytes};
    } },
    { id: 'file-workflow', prompt: '使用 codemode 和 fixture MCP 工具完成文件工作流：写入 input.json，内容为 {"values":[8,3,11,5]}；回读解析，从小到大排序并计算 sum、average；把结果 {"sorted":[3,5,8,11],"sum":27,"average":6.75} 写入 calculated.json，再回读核对。只操作 fixture 的临时工作区，不使用其他文件系统。', check: () => {
      const result=JSON.parse(readFileSync(join(workspace,'calculated.json'),'utf8'));assert.deepEqual(result,{sorted:[3,5,8,11],sum:27,average:6.75});return result;
    } },
    { id: 'error-recovery', prompt: '使用 codemode 调用 fixture 的 report_failure 工具，这是一个预期的业务错误测试。检查 CallToolResult.isError 和 structuredContent.code，不能把请求返回当作业务成功，也不要重复调用这个错误工具。随后调用只读 get_metrics，证明会话仍可继续，并把 {"observedError":true,"code":"EXPECTED_TEST_FAILURE","recoveryReadSucceeded":true} 保存到 error-observation.json，再回读。', check: () => {
      const result=JSON.parse(readFileSync(join(workspace,'error-observation.json'),'utf8'));assert.deepEqual(result,{observedError:true,code:'EXPECTED_TEST_FAILURE',recoveryReadSucceeded:true});return result;
    } },
  ];
  for (const task of cases) {
    const state:any={name:task.id,passed:false,startedAt:new Date().toISOString(),calls:[],requests:0};report.tests.push(state);save();
    let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const settings=SettingsManager.inMemory({defaultTools:['+codemode','+tool_search'],compaction:{enabled:false},retry:{enabled:false,maxRetries:0}});
      const loader=new DefaultResourceLoader({cwd:workspace,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,
        eventBus:service.createEventBus(task.id),extensionFactories:[...service.getInlineExtensions({welcomeMode:'coding',sessionLabel:task.id}),
          createMcpSideEffectExtension({taskId:task.id,taskRoot:workspace,providerIds:['fixture'],getPermissionMode:()=> 'auto',requestApproval:async()=>false})]});
      await loader.reload();
      const result=await createAgentSession({cwd:workspace,agentDir,modelRuntime,model,thinkingLevel:'high',settingsManager:settings,
        sessionManager:SessionManager.inMemory(workspace),resourceLoader:loader,noTools:'builtin'});
      session=result.session;service.attachSession(task.id,result.extensionsResult,['fixture']);
      session.subscribe(event=>{
        if(event.type==='message_start'&&event.message.role==='assistant'){state.requests++;if(state.requests>8)void session?.abort();}
        if(event.type==='tool_execution_end') state.calls.push({tool:event.toolName,id:event.toolCallId,parent:event.parentToolCallId,isError:!!event.isError});
      });
      await session.bindExtensions({});
      timer=setTimeout(()=>{state.timedOut=true;void session?.abort();},180000);
      await session.prompt(task.prompt);
      assert(!state.timedOut,'Real-model task timed out');
      assert(state.calls.some((call:any)=>call.tool==='codemode'),'Model did not use codemode');
      assert(state.calls.some((call:any)=>call.parent&&call.tool.startsWith('mcp__fixture__')),'No real nested MCP call');
      if(task.id==='error-recovery')assert.equal(state.calls.filter((call:any)=>call.tool==='mcp__fixture__report_failure'&&call.isError).length,1);
      state.result=task.check();state.answer=session.getLastAssistantText();state.passed=true;console.log('PASS real-model '+task.id);
    } catch(error){state.error=error instanceof Error?error.message:String(error);console.error('FAIL real-model '+task.id+': '+state.error);}
    finally{clearTimeout(timer);if(session){await session.extensionRunner?.emit({type:'session_shutdown',reason:'quit'});session.dispose();}service.detachSession(task.id);state.finishedAt=new Date().toISOString();save();}
  }
} catch(error){report.setupError=error instanceof Error?error.message:String(error);console.error(report.setupError);}
finally{service?.dispose();rmSync(temp,{recursive:true,force:true});report.finishedAt=new Date().toISOString();save();process.exitCode=report.setupError||report.tests.length!==3||report.tests.some((task:any)=>!task.passed)?1:0;}
