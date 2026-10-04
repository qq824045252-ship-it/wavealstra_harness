/** Build an evidence-backed acceptance note; never overwrite another run's document. */
const fs=require('node:fs'),path=require('node:path');process.chdir(path.resolve(__dirname,'..'));
const base='artifacts/pi100-upgrade',buildId=process.argv[2];if(!/^build-\d+$/.test(buildId??''))throw Error('Exact build identifier required');
const audit=JSON.parse(fs.readFileSync(path.join(base,'integrity-results.json')));if(audit.status!=='passed'||audit.buildId!==buildId)throw Error('Matching integrity proof required');
const build=JSON.parse(fs.readFileSync(path.join(base,buildId,'build.json')));
const features=JSON.parse(fs.readFileSync(path.join(base,'features-results.json')));
const admission=JSON.parse(fs.readFileSync(path.join(base,'model-admission-results.json')));
const migration=JSON.parse(fs.readFileSync('artifacts/pi099-migration/integration.json'));
const promotion=JSON.parse(fs.readFileSync(path.join(base,'promotion-results.json'),'utf8').replace(/^\uFEFF/,''));
const official=[['Pi 1.0.0 发布说明','https://pi.dev/changelog'],['原生 Code Mode','https://pi.dev/docs/latest/codemode'],['原生 MCP / OAuth','https://pi.dev/docs/latest/mcp'],['官方 v1.0.0 标签','https://github.com/earendil-works/pi/releases/tag/v1.0.0']];
const descriptions={
 'minimal-no-prompt':'最小模式：原生 Code Mode + 真实 stdio MCP 随机数据计算与写回',
 'bugfix-prompt-control':'修 Bug 标签：保留场景提示词，同时保持原生 Code Mode',
 'office-native-discovery':'办公场景：原生 tool_search + MCP，不开启 Code Mode',
 'codemode-without-mcp':'无 MCP：Code Mode 调用原生 read/write 完成真实文件计算',
 'native-models-and-reference':'原生模型目录、非聊天模型 API 和打包参考文档读取',
 'native-error-repair':'先失败 exit=7，再修复输入并得到 exit=0，校验程序哈希不变',
 'native-readonly-worker':'真实只读子任务读取随机输入，主任务保存结果，独立校验一致',
};
const nativeRows=audit.packages.map(r=>`| ${r.name} | ${r.version} | ${r.comparedFiles??'仅版本核对'} | ${r.changedFiles?.join('<br>')||'无本地代码补丁'} |`).join('\n');
const liveRows=audit.desktop.flatMap(r=>r.tests.map(t=>`| ${descriptions[t.name]||t.name} | \`${r.model}\` | 通过 | \`${r.report.replaceAll('\\','/')}\` |`)).join('\n');
const checks=audit.checks.map(r=>`| \`${r.name}\` | ${r.status} | ${r.at} |`).join('\n');
const text=`# MyBuddy · Pi 1.0.0 升级与验收记录

核验时间（UTC）：${audit.at}。对应官方 Pi 1.0.0（2026-10-01 发布）。

## 结论与验收口径

八个 Pi 运行时包统一为 1.0.0；本记录对应的源码、免安装程序、Code Mode Worker 和子任务运行时一致。${audit.checks.length} 个检查入口通过，${audit.desktop.length} 组真实桌面任务通过，另有 1 组脱离仓库目录的真实模型便携 Worker 测试通过。真实任务使用隔离账户目录和随机输入，不操作 ERP 或其他生产业务数据，临时凭据全部清理。

这里的“通过”指下面逐项列出的范围，不等于所有模型、全部第三方 MCP 服务、所有 OAuth 交互或所有终端环境都做过端到端测试。未验证项见文末。

## 1.0 新变化与 MyBuddy 处理

| 官方变化 | MyBuddy 处理 | 证据类型 |
|---|---|---|
| 更精简的 Code Mode 提示与按需参考文档 | 保留上游原生实现；主程序、Worker 一并打包原生 docs；修正嵌入宿主中的文档路径 | 真实桌面模型实际读取包内 codemode.md；文件哈希核验 |
| models.generateImages、类型化目录、分类及费用归集 | 解除 coding 场景 models:false；共用原生 ModelRegistry / ModelRuntime 和认证；不提供脚本内聊天流，不引入自动分类路由 | 原生 QuickJS / SDK 接口与费用测试；真实目录查询；收费生图未实测 |
| 可恢复的成员、参数、模型和存储错误 | 使用 1.0 原生错误，不复制实现 | 原生 QuickJS 测试与真实 shell 错误修复 |
| MCP OAuth 按服务器名和 URL 隔离凭据 | 修正宿主 status、hasCredentials、logout 的调用参数；保留旧凭据一次性迁移 | 同 URL 双账户隔离、注销与迁移测试 |
| authServerMetadataUrl、RFC9207 iss 校验、step-up scope | 配置字段透传；校验安全 URL；上游原生 OAuth 负责令牌流程 | 协议级受控响应测试；真实外部网页登录未覆盖 |
| MCP 延迟工具在 reload / resume 后恢复 | 原生恢复行为 + 下述 SDK 入口最小修复 | 真实 stdio 服务、热重载、持久化会话冷重开 |
| Fullscreen TUI / quietStartup:header | 作为终端功能继承上游；不把 Electron 窗口改为强制全屏 | 未作为桌面 UI 新功能宣称 |
| Radius 登录及 MCP 配置、Anthropic copy-code 登录 | 保留原生 provider/auth 能力；不自动绑定新账户、不凭空创建远程 MCP 配置 | 本轮未进行用户外部授权交互 |

官方所述约 40% 的 Code Mode 提示缩减是其示例，不是本轮对 MyBuddy 实测的节省比例。

## Review 中修复的问题

1. MyBuddy 在原生 Code Mode 工厂中固定 models:false，会遮蔽原生非聊天模型能力；已在 coding 场景启用，办公/设计仍不自动开启 Code Mode。
2. MCP 1.0 OAuth 凭据签名改为 server name + URL，旧宿主调用会误判登录状态或错误处理注销；status / 查询 / 注销一起修正。
3. NativeMcpConfig 未传递 oauth.authServerMetadataUrl；现保留 HTTPS/回环 HTTP 的安全限制，并拒绝含凭据或 fragment 的 URL。
4. 子任务启动器原先固定 0.99.2；现和主进程、原生 MCP、Code Mode、WASM 统一版本与构建产物。
5. 1.0 按需读取参考文档，在 Electron 打包环境不能依赖开发机 node_modules 路径；主程序与子任务均携带官方文档。
6. 开启原生 image/classifier 后，必须尊重用户停用 Provider、会话撤销与取消信号。扩展的是现有请求准入校验，不是另建运行时或新增自动评分/续跑控制层。
7. 持久化会话冷重开用例复现 Pi 1.0 SDK 的恢复入口遗漏：createAgentSession 总是传 initialActiveToolNames，使 AgentSession 构造器不调用自己的 _restoreToolsFromTranscript。补丁只在“已有会话且无显式 tools/noTools 覆盖”时让原生恢复逻辑执行；显式工具限制保持不变。修复前工具返回 not found，修复后同一回归通过。

原 0.99.2 MCP 宿主补丁含大量 CRLF 噪声，已重建为针对干净 1.0.0 的小补丁；当前 coding-agent 补丁 ${audit.packages.find(p=>p.name==='pi-coding-agent').patchBytes} 字节。保留的 pi-ai 补丁仅适配 CommandCode 的 reasoning delta 别名。并非“零补丁”，也没有修改原生 Agent 主循环。

## 原生包完整性

下表中提供 compiled npm 内容的包，逐文件与本轮校验过的官方 npm 解包内容比较；有差异的文件必须与本地补丁白名单完全一致。其余三个包核对实际安装版本及依赖统一性。

| 包 | 版本 | 比较文件数 | 允许的本地差异 |
|---|---|---:|---|
${nativeRows}

子任务 runtime 逐文件比较：${audit.childRuntime.filesCompared} 个文件全部匹配。主进程 Code Mode CJS / QuickJS WASM 也与发布副本一致。

## 真实任务结果

这些行使用真实模型、真正的免安装 MyBuddy.exe、界面输入、原生事件和持久化会话，不是 scripted-model 回答。

| 任务 | 真实模型 | 结果 | 证据 |
|---|---|---|---|
${liveRows}

每组均验证流式文本、完成结果和会话保存；临时凭据清理完成；渲染器错误列表为空。另一并行构建产生了相同 SHA-256 的程序，复用了其中已完成的故障修复结果，没有重复调用同一付费任务。验收按实际程序哈希，而非只按文件夹名称匹配。

独立 Worker：复制到临时非仓库目录，使用真实模型读取随机 nonce 与数字，独立核对 sum=56；不依赖用户安装另一份 Pi；临时凭据清理完成。

## 原生集成与回归

Pi 1.0 专项：${features.results.filter(r=>r.status==='passed').length}/${features.results.length}；非聊天模型准入：${admission.results.filter(r=>r.status==='passed').length}/${admission.results.length}；原生 MCP/QuickJS/会话集成：${migration.tests.filter(t=>t.passed).length}/${migration.tests.length}。

上述专项中的模型返回和 OAuth 服务响应使用受控测试数据，不能冒称真实生图服务或真实授权登录通过。MCP 集成则真实启动 stdio 进程并读写临时文件，覆盖读并发、写串行、权限拒绝、错误结果、父子工具身份、取消、重连、热重载和冷恢复。

架构检查：321/321。源码边界扫描：721 文件、无违规项。模型刷新/旧缓存覆盖、原生推理流、压缩失败与取消、记忆竞争和上下文边界也纳入本轮检查。

| 检查入口 | 最后结果 | 执行时间 UTC |
|---|---|---|
${checks}

## 发布与回退

- 已验证程序：\`${build.cleanExecutable}\`。
- 桌面快捷方式：\`${promotion.after.path}\`，已指向上述程序。
- 原快捷方式备份：\`${promotion.backup}\`。
- 旧免安装目录保留；未停止用户正在运行的旧实例。已有窗口不会热更新，退出旧实例（含托盘）后从桌面入口启动新包。
- 当前源码指纹：\`${audit.sourceFingerprint}\`。
- app.asar SHA-256：\`${audit.asarSha256}\`。
- 完整机器可读证据：\`artifacts/pi100-upgrade/integrity-results.json\`；发布记录：\`promotion-results.json\`。

本轮未自动 git commit / push；保留已有修改和并行添加的 context-mode 边界测试，不把并行改动或已有删除算成本轮修改。测试过程会更新原有报告文件，Git 提交时应分类审阅。升级准备脚本中的一次性修改器不是幂等重放入口；日常复验使用 test:pi100-*、pi100-run-checks、pi100-desktop-live 和 pi100-integrity-audit。

## 未宣称已端到端通过的范围

真实目录查询返回 availableImageCount=0，因此本轮没有对外部收费图像模型发起真实生成；图像块、参数错误、费用与取消接口已用原生 SDK / QuickJS 专项验证。Radius / Anthropic 新登录流程、任意第三方 MCP OAuth 浏览器交互和所有 Provider 组合未做用户授权实测。远程前端类型检查及构建通过，不等同于本轮重新安装并实测 Android APK。Pi Durable 是独立产品，本轮没有把它引入 MyBuddy 或新增宿主任务控制层。

## 官方资料

${official.map(([name,url])=>'- ['+name+']('+url+')').join('\n')}
`;
const file=path.join('docs','pi100-acceptance-'+buildId.slice(6)+'.md');fs.mkdirSync('docs',{recursive:true});fs.writeFileSync(file,text,{flag:'wx'});console.log(JSON.stringify({file,bytes:Buffer.byteLength(text),checks:audit.checks.length,desktopRuns:audit.desktop.length},null,2));
