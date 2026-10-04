/** Final acceptance record belongs to one immutable distribution, not a moving worktree. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const frozenDir='artifacts/pi099-migration/frozen';
async function hash(file){const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
(async()=>{
 const distribution=read(frozenDir+'/distribution.json');
 const firstDesktop=read(frozenDir+'/desktop-live/results.json');
 const approvedSubagent=read(frozenDir+'/subagent-approved/results.json');
 const firstNames=['repository-inventory','unseen-input-transform','real-shell-failure-and-repair'];
 if(firstNames.some(name=>!firstDesktop.tests.some(t=>t.name===name&&t.status==='passed')))throw Error('Required original packaged tasks failed');
 if(approvedSubagent.status!=='passed'||!approvedSubagent.tests.some(t=>t.name==='native-subagent'&&t.status==='passed'))throw Error('Approved SubAgent retry has not passed');
 if(firstDesktop.executable!==distribution.executable||approvedSubagent.executable!==distribution.executable)throw Error('Desktop evidence belongs to another executable');
 const desktop={status:'passed',tests:[...firstDesktop.tests.filter(t=>firstNames.includes(t.name)).map(t=>({...t,evidence:frozenDir+'/desktop-live/results.json'})),...approvedSubagent.tests.map(t=>({...t,evidence:frozenDir+'/subagent-approved/results.json'}))],cleanupWarning:approvedSubagent.cleanupError??firstDesktop.cleanupError??null};
 const assets=read(frozenDir+'/packaged-assets.json');
 const required=['repository-inventory','unseen-input-transform','real-shell-failure-and-repair','native-subagent'];
 if(desktop.status!=='passed'||required.some(name=>!desktop.tests.some(t=>t.name===name&&t.status==='passed'))||desktop.tests.some(t=>t.status!=='passed'))throw Error('Frozen desktop acceptance has not passed');
 if(!assets.passed||assets.distribution!==distribution.destination)throw Error('Frozen asset acceptance is missing');
 const critical=[];
 for(const entry of distribution.files){const actual=await hash(path.join(distribution.destination,entry.file));if(actual!==entry.sha256)throw Error('Tested file changed: '+entry.file);critical.push({...entry,unchangedAfterTests:true});}
 const references={
  closeout:'artifacts/pi099-closeout/regression/results.json',
  integration:'artifacts/pi099-migration/integration.json',
  oauth:'artifacts/pi099-migration/oauth.json',
  encryption:'artifacts/pi099-migration/encryption.json',
  history:'artifacts/pi099-migration/history.json',
  liveSdk:'artifacts/pi099-migration/live-tasks.json',
  frozenDesktop:frozenDir+'/desktop-live/results.json',
  approvedSubagent:frozenDir+'/subagent-approved/results.json',
  frozenAssets:frozenDir+'/packaged-assets.json',
 };
 const reports=Object.fromEntries(Object.entries(references).map(([key,file])=>[key,read(file)]));
 for(const key of ['integration','oauth','liveSdk'])if(reports[key].setupError||reports[key].tests.some(t=>t.passed!==true))throw Error('Acceptance failed: '+key);
 if(reports.closeout.status!=='passed'||!reports.encryption.passed||!reports.history.passed)throw Error('Regression/encryption/history evidence failed');
 const pkg=read('package.json');
 const results={
  recordedAt:new Date().toISOString(),executable:distribution.executable,
  distributionCreatedAt:distribution.createdAt,criticalFiles:critical,
  sourceRevision:cp.execFileSync('C:/Program Files/Git/cmd/git.exe',['rev-parse','--short','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
  tests:{closeout:{passed:reports.closeout.tests.filter(t=>t.status==='passed').length,total:reports.closeout.tests.length},nativeMcp:{passed:reports.integration.tests.length,total:reports.integration.tests.length},oauth:{passed:reports.oauth.tests.length,total:reports.oauth.tests.length},realSdk:{passed:reports.liveSdk.tests.length,total:reports.liveSdk.tests.length},realDesktop:{passed:desktop.tests.length,total:desktop.tests.length},encryptedStorage:true,historyReload:true,frozenWorkerAndWasm:true},
  desktopTasks:desktop.tests.map(t=>({name:t.name,status:t.status,result:t.result,evidence:t.evidence})),
  priorAttempt:{status:firstDesktop.status,subagent:firstDesktop.tests.find(t=>t.name==='native-subagent')?.error,explanation:'The first additional SubAgent scenario waited for the existing plan approval and timed out. The isolated retry uses the real visible plan approval button; the prior failure is not erased.'},
  legacyAdapterDependencyRemoved:!pkg.dependencies?.['pi-mcp-adapter']&&!pkg.devDependencies?.['pi-mcp-adapter'],
  externalValidation:{erp:{status:'blocked-by-environment',scriptPathCorrectedAndBackedUp:true,api:'127.0.0.1:3000',database:'127.0.0.1:5432',businessDataMutated:false},oauthAccounts:{status:'not-authorized-by-tests',protocolFixturePassed:true,oldCredentialStoreDeleted:false}},
  scope:'All distribution claims apply only to this fixed directory and verified hashes. Concurrent later worktree changes are not silently included.',
  cleanupWarning:desktop.cleanupWarning??null,evidence:references,
 };
 fs.writeFileSync(frozenDir+'/final-verification.json',JSON.stringify(results,null,2));
 const text=`# Pi 0.99.1 修复与固定发行包验收\n\n记录时间：${results.recordedAt}\n\n## 交付版本\n\n实际仓库：\`C:\\Users\\servi\\Documents\\GitHub\\wavealstra_harness\`。Git 基线：\`${results.sourceRevision}\`，保留未提交改动，未自动提交。\n\n固定发行包：\`${distribution.executable}\`。未覆盖原有安装。\n\n四个关键文件（EXE、app.asar、Codemode Worker、QuickJS WASM）均记录 SHA-256，并在真实任务结束后再次核对，全部一致。后续工作区改动不会自动进入这个发行包。\n\n## 修复范围\n\n| 问题 | 已落实处理 |\n|---|---|\n| 管理页与任务 MCP 执行链分裂 | 统一 Pi 原生 MCP，复用配置和加密授权存储，状态显式绑定会话；旧 adapter 依赖和执行构建链已移除。 |\n| SDK 没有桌面管理页接口 | 增加固定 0.99.1 的 pnpm patch，仅暴露宿主状态和管理动作，仍执行 Pi 原生协议；后续升级需重新审查补丁。 |\n| 打包后找不到 Worker/WASM | 打入原始 Worker 和 WASM，配置 asarUnpack 和显式路径，实际发行包执行验证通过。 |\n| 原生工具被误当 MCP、只读被误拦 | 补全工具身份、精确服务器匹配；只读允许有明确证据的读取，拒绝子调用写入与其他副作用。 |\n| 并发写入及取消 | 使用 Pi 原生执行队列：明确只读可并发，其他 MCP 调用串行；取消测试验证没有额外落盘。 |\n| 子调用关系和历史丢失 | parentToolCallId 贯通事件/IPC/界面；从 Pi nestedCalls 恢复历史错误及取消状态，保留不完整记录警告。 |\n| Shell 错误被记作退出 0 | 识别 Pi 0.99 的结构化 isError / exit_code，验证命令首次退出 7、修复输入后退出 0。 |\n| OAuth 生命周期 | 真实原生 PKCE、凭证共享、401 刷新、退出/取消与销毁竞态有独立测试；OS 加密存储拒绝明文降级。 |\n| ERP 入口移动 | 原配置已备份，仅修正失效 stdio 脚本路径，未修改 ERP 业务数据。 |\n\n## 验证结果\n\n| 组别 | 结果 |\n|---|---|\n| 收尾脚本（包含若干专项入口与类型检查） | ${results.tests.closeout.passed}/${results.tests.closeout.total} 通过 |\n| 原生 MCP 真实协议/临时文件集成场景 | ${results.tests.nativeMcp.passed}/${results.tests.nativeMcp.total} 通过 |\n| 本地 OAuth 协议场景 | ${results.tests.oauth.passed}/${results.tests.oauth.total} 通过 |\n| 真实模型 + SDK 任务 | ${results.tests.realSdk.passed}/${results.tests.realSdk.total} 通过 |\n| 真实模型 + 固定桌面发行包任务 | ${results.tests.realDesktop.passed}/${results.tests.realDesktop.total} 通过 |\n| 真实 Electron OS 加密、会话历史、固定包 Worker/WASM | 通过 |\n\n这些组别存在包含关系，不应相加为互不重复的测试数。确定性模型驱动的 Agent 集成与真实供应商模型任务在原始报告中明确区分。\n\n固定发行包的四类任务（跨首次运行与 SubAgent 审批复测，均为同一哈希固定副本）从实际输入框发送，经 IPC、原生工具及磁盘回读验收：\n\n${desktop.tests.map(t=>'- '+t.name+'：通过；'+JSON.stringify(t.result)).join('\n')}\n\n首次 SubAgent 尝试进入现有计划审批后等待超时，原失败记录保留。专项复测通过实际计划卡的批准按钮继续，不关闭权限检查、不伪造授权。\n\n源码清单使用测试开始时从真实仓库复制的只读快照，防止并行编辑改变验收预期；随机输入在模型运行前生成，没有预填答案。命令失败恢复校验了验证脚本哈希未变。\n\n## 尚未验证的外部条件\n\nERP 的本地 API 与 PostgreSQL 未运行，ERP 业务数据端到端测试被环境阻塞，不能声称已经通过。没有启动数据库迁移、导入采购单或修改库存。\n\nOAuth 测试使用本地协议服务器，不代表 Canva 等外部账户已重新授权。旧凭证没有删除或盲目导入；原生 MCP 需要时应由用户完成对应服务授权。\n\n## 证据与使用\n\n最终索引：\`${frozenDir}/final-verification.json\`。原始日志与失败后的复测记录保留在 \`artifacts/pi099-migration\` 和 \`artifacts/pi099-closeout\`。\n\n测试发行包可直接运行上述目录中的 MyBuddy.exe；它与旧安装并存。不要同时打开两个使用同一正式用户配置的 MyBuddy 实例。实际验收使用独立临时配置，其清理结果记录在桌面报告中。\n`;
 fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/Pi-0.99.1-fixed-build-acceptance_2026-09-30.md',text);
 console.log(JSON.stringify({executable:results.executable,tests:results.tests,criticalHashesUnchanged:true,cleanupWarning:results.cleanupWarning,report:'docs/Pi-0.99.1-fixed-build-acceptance_2026-09-30.md'},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
