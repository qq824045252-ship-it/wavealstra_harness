/** Acceptance is bound to current source, tested portable, and real task reports. Never starts a model or mutates a user profile. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');process.chdir(root);
const out='artifacts/pi-codemode-auto',read=name=>JSON.parse(fs.readFileSync(path.join(out,name),'utf8'));
function fingerprint(){const files=[];function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){if(e.isSymbolicLink())continue;const f=path.join(p,e.name);if(e.isDirectory())walk(f);else files.push(f)}}for(const p of ['src','app/remote/src','shared/src'])if(fs.existsSync(p))walk(p);const h=crypto.createHash('sha256');for(const f of files.sort())h.update(f).update(fs.readFileSync(f));return h.digest('hex')}
const regression=read('regression-results.json'),contract=read('contract-results.json'),native=read('native-results.json'),ui=read('ui-observer-results.json'),integrity=read('upstream-core-integrity.json'),live=read('desktop-live/results.json');
const pointer=read('build-latest.json'),build=JSON.parse(fs.readFileSync(pointer.report,'utf8'));
assert.equal(regression.status,'passed');assert(regression.sourceUnchanged);assert.equal(fingerprint(),regression.sourceFingerprint,'Source changed after regression');
assert(contract.passed&&native.passed&&ui.passed&&integrity.passed);
assert.equal(build.status,'passed');assert(build.sourceUnchanged);assert.equal(live.status,'passed');
assert.equal(live.tests.length,5);assert(live.tests.every(t=>t.status==='passed'));
assert.equal(live.modeFallbackChecks.length,2);assert(live.modeFallbackChecks.every(t=>t.status==='passed'&&t.realReplyVerified));
assert(live.temporaryCredentialsRemoved);assert.equal(live.rendererErrors.length,0);
assert.equal(live.asarSha256,build.asarSha256);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(build.asar)).digest('hex'),build.asarSha256);
for(const t of live.tests){assert.equal(t.chip.state,t.nativeCodeMode.active?'enabled':'disabled');assert.equal(t.chip.taskId,t.taskId);assert.equal(t.persistedMode,t.nativeCodeMode.welcomeMode);}
const delivery=fs.existsSync(path.join(out,'deployment.json'))?read('deployment.json'):{status:'packaged-only',runningInstanceChanged:false};
const summary={at:new Date().toISOString(),status:'passed',behavior:{coding:'native codemode on + tool_search',working:'no codemode; native deferred/direct MCP + tool_search',design:'no codemode; native deferred/direct MCP + tool_search',models:false,defaultWelcomeMode:'working',showPendingBeforeSession:true},validation:{regressionSuites:regression.tests.length,contractCases:contract.results.length,nativeIntegrationCases:native.results.length,uiObserverCases:ui.results.length,realDesktopSceneTasks:live.tests.length,realBackendModeChecks:live.modeFallbackChecks.length,coreFiles:integrity.packages.reduce((n,p)=>n+p.checks.length,0),rendererErrors:live.rendererErrors.length,retiredControlMessages:live.sessionAudit.reduce((n,s)=>n+s.retiredControlMessages,0),observedModels:[...new Set(live.sessionAudit.flatMap(s=>s.observedModels||[]))]},package:{executable:build.executable,asarSha256:build.asarSha256,buildInputFingerprint:build.sourceFingerprint,regressionSourceFingerprint:regression.sourceFingerprint},delivery};
fs.writeFileSync(path.join(out,'closeout-summary.json'),JSON.stringify(summary,null,2)+'\n');
const realRows=live.tests.map(t=>`| ${t.name} | ${t.persistedMode} | ${t.nativeCodeMode.active?'已启用':'未启用'} | 通过 |`).join('\n');
const doc=`# MyBuddy · Pi Code Mode 按场景自动启用验收

记录时间（UTC）：${summary.at}

## 功能结果

代码开发 coding 自动启用 Pi 原生 Code Mode，使用 mode=on，保留原生直接工具调用；models=false 保持不变。日常办公 working 和设计创意 design 不注册 Code Mode，但始终保留 Pi 原生 tool_search。普通办公、设计仍可发现并直接调用 MCP 工具。

欢迎页和聊天顶部显示 Pi Code Mode 状态。代码场景尚未建立原生会话时显示“待启用”；绑定后读取 session.getActiveToolNames()，真实激活才显示“已启用”。办公和设计显示“未启用”。标识为只读状态，不启动工具、不调用模型、不增加 MyBuddy 执行控制层。

## 修复的缺陷与处理

| 问题 | 处理 |
|---|---|
| 缺失场景在发送、恢复、远程请求、显示等位置回退为 coding | 统一 DEFAULT_WELCOME_MODE=working；入口使用 resolveWelcomeMode；明确保存的 coding/design 不改写 |
| 单纯注册 createCodemodeExtension(mode=on) 不保证实际激活 | 通过已有工具装配边界调用 Pi 原生 setActiveToolsByName；配置重载后仍保持激活，无 MCP 或 MCP 禁用也可使用 |
| 关闭 Code Mode 后 codemode-only MCP 会失去入口 | 会话级配置投影将 codemode exposure 映射为 deferred，关闭 autoEnableCodemode；保留 direct/hidden，不修改用户 mcp.json |
| 新建任务继承代码场景 | 新任务重置为默认 working 和通用办公 preset；明确选择代码/设计后仍正常使用 |
| 界面可能把管理会话状态当作当前任务状态 | 查询和订阅均按真实 taskId 过滤，丢弃其他任务与 mcp-headless 快照 |
| 初始快照迟到覆盖新会话事件、卸载后写入 | 订阅先于读取；事件版本和卸载标记防竞态；会话释放后取消“已启用”标识 |
| preload 类型声明未体现后端已经支持的 taskId | 修正 status(taskId?) 类型契约，实际读取当前任务 |
| 未结束的 Pi 会话被重新标记为新场景 | 仅空闲会话才允许更新绑定场景；不在流式执行中改工具环境 |

设置只决定工具是否提供给当前场景，不判断任务复杂度，不干预 Pi 内部选择直接调用还是脚本编排，也不在结束后追加继续消息。原有审批、只读、目录隔离、模型范围和记忆撤销保护保留。

## 验证

${summary.validation.regressionSuites} 个回归套件通过，测试前后源码指纹一致。包含 ${summary.validation.contractCases} 个新功能契约断言、${summary.validation.nativeIntegrationCases} 个真实已安装 Pi SDK/真实 stdio MCP 场景、${summary.validation.uiObserverCases} 个生产界面观察器竞态用例。SDK 场景中的 provider 为受控本地实现，与下面的真实模型任务明确区分。

Pi 0.99.2 的 ${summary.validation.coreFiles} 个核心 JavaScript 文件与经过完整性校验的官方 npm 发布物逐字节相同；本任务未升级或修改 Pi 核心。

桌面、远程前端类型检查、构建和免安装打包通过。没有把前端编译通过等同于 Android APK 安装或手机真机验收。

### 实际新包中的真实模型任务

| 任务 | 实际保存场景 | 原生 Code Mode 状态 | 结果 |
|---|---|---|---|
${realRows}

每项使用本次随机 nonce/数字，真实工具读取后计算、保存并由测试程序核对文件内容。界面输入、场景按钮、IPC、流式事件、原生工具、数据库场景与会话状态相互核对。五项是不同的真实任务，不通过修改 badge 文案伪造状态。

另有两项真实模型后端请求验证：新任务未传 welcomeMode 时为 working；已有 coding 任务未传字段时保持已保存的 coding。两项都检查实际模型回复和会话文件。

真实模型：${summary.validation.observedModels.join('、')}。渲染器未捕获异常 ${summary.validation.rendererErrors}；退役隐藏控制消息 ${summary.validation.retiredControlMessages}。测试配置/凭据均在隔离目录，已清理；没有修改真实用户的邮件、记忆或业务数据。

### 失败记录

首轮实际新包验收发现：临时 defaultTools 覆盖被原生配置重载清除，导致无 MCP 的代码任务未启用 Code Mode；新建任务继承上一代码场景。两处均修复生产代码，并新增配置重载/禁用 MCP 和真实新任务场景回归，重新构建新包。首次实际失败报告保留在 desktop-live-initial/results.json。

初次回归的架构断言将 attachExtensions 的参数文本写死，新增只读状态绑定参数后被触发；更新该契约，保留生命周期所有权断言，重新跑完整套件。原生测试最初误从 context.tools 取声明，已改用 Pi 0.99.2 的 getCurrentTools(messages)，未修改生产执行逻辑来迁就测试。初始报告保留在 regression-initial-results.json、native-before-diagnostics.json 和对应日志中。

## 交付

免安装程序：

    ${build.executable}

app.asar SHA-256：\`${build.asarSha256}\`

构建输入指纹：\`${build.sourceFingerprint}\`

回归源码指纹：\`${regression.sourceFingerprint}\`

交付状态：${delivery.status}。${delivery.runningInstanceChanged?'已验证新程序运行。':'未强制关闭或替换用户当前运行实例；使用本功能需运行上述新包。'}

## 可复核记录

artifacts/pi-codemode-auto 下：contract-results.json、native-results.json、ui-observer-results.json、regression-results.json、upstream-core-integrity.json、build-latest.json 指向的 build.json、desktop-live/results.json 及截图、closeout-summary.json。

## 范围

本次是按明确场景设置原生能力和显示真实状态；没有提供“自动/始终/关闭”三态高级开关，没有启用模型分类器，也没有给 Android 前端新增 badge 或安装 APK。既有用户模式提示词、技能和已保存任务场景继续保留。
`;
const docPath='docs/MyBuddy-Pi-CodeMode-auto_2026-10-01.md';fs.writeFileSync(docPath,doc,'utf8');
console.log(JSON.stringify({status:summary.status,validation:summary.validation,package:summary.package,delivery,document:docPath},null,2));
