# MyBuddy · Pi 0.99.1 迁移验收

生成时间：2026-09-30T01:53:07.901Z

本次验收：**通过**。本结论覆盖下述迁移范围和已执行测试，不代表所有外部服务、所有模型或整个仓库从此不存在问题。

## 基线与交付

仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`。开始时已有未提交改动，本轮保留，不执行 reset、commit 或 push。

目标版本：`@earendil-works/pi-ai@0.99.1`、`@earendil-works/pi-coding-agent@0.99.1`。

便携程序：`release-pi099-closeout/win-unpacked/MyBuddy.exe`。未覆盖正在使用的已安装 MyBuddy，未修改其用户配置或生产业务数据。

最终源码指纹：`ccc1d8ace4afd01a35701ad21236694b833b22a85f5c4895c2841a0c0376386a`；构建后发生变化的源码文件：[]。

## 已处理

- MCP 管理与任务执行统一使用 Pi 原生连接、发现、OAuth 和工具调用；管理会话与任务会话状态独立，不向不存在的任务回退全局连接。
- 移除 pi-mcp-adapter 依赖、旧 vendor bundle、采样适配、旧脚本 worker 与打包入口。保留旧会话的工具名解读，不删除用户历史或旧凭据。
- 原生 MCP 名称、结构化 CallToolResult、父子调用标识、只读拒绝远端/本地副作用、只读并发与写入串行均经过测试。
- 修复非零 Shell 返回值被误记成退出码0的漏洞；失败状态、结构化 exit_code 与审计一致；错误命令仍可由模型检查后恢复。
- 修复重复点击登录引发双OAuth流程、运行时关闭后迟到的授权、非法transport/cwd/oauth/directTools配置被静默接受。
- OAuth凭据在Electron中使用OS加密存储，明文存储被拒绝；共享登录、刷新、退出在本地协议测试中验证。
- Codemode原生Worker/WASM作为明确的ASAR-unpacked资源打包；不依赖开发目录的相对路径。
- 子代理同版本原生Pi CLI/SDK合并为一个包内Worker Runtime；Node嵌入宿主不再误启动自身脚本，便携包不要求另装全局Pi。
- Jev/Virtual Models自动路由不纳入此次迁移。Codemode不额外暴露未纳入宿主模型准入的classifier API；原有显式多模型会诊保留。

## SDK适配补丁

这不是完全未修改的上游SDK。`patches/@earendil-works__pi-coding-agent@0.99.1.patch` 增加桌面宿主状态/控制接口以及Worker/WASM定位导出，协议执行和OAuth仍使用Pi原生实现。后续升级Pi必须重新核验该补丁和构建资源，不可只改版本号。

## 自动回归

| 项目 | 结果 | 证据 |
|---|---|---|
| 命令级回归 | 24/24 | artifacts/pi099-closeout/regression/results.json |
| 原生MCP集成场景 | 14/14 | artifacts/pi099-migration/integration.json |
| 管理面边界与模型调用范围 | 4/4 | artifacts/pi099-closeout/manager-lifecycle.json |
| 本地OAuth协议场景 | 6/6 | artifacts/pi099-migration/oauth.json |
| 生产构建 | passed | artifacts/pi099-closeout/build/results.json |
| 便携打包 | passed | artifacts/pi099-closeout/pack/results.json |
| 独立目录真实模型Worker | passed | artifacts/pi099-closeout/portable-worker.json |

命令级回归和子场景有包含关系，不能相加冒充独立测试总数。

## 实际便携桌面的真实模型任务

模型使用已有授权的 `commandcode/deepseek/deepseek-v4.1-flash`。通过实际输入框提交，经过IPC、Agent循环、工具调用、可见状态与历史持久化。程序工作目录为隔离临时目录，而不是源码目录。测试过程可以出现预期错误或模型自行纠错，以独立检查实际结果为准。

| 任务 | 结果 | 独立核验 |
|---|---|---|
| repository-inventory | passed | {"total":680,"totalBytes":7886032,"largest":[{"path":"src/main/agent/AgentService.ts","bytes":250775},{"path":"src/renderer/src/store/appStore.ts","bytes":248342},{"path":"src/main/db/AppDatabase.ts","bytes":167004}]} |
| unseen-input-transform | passed | {"nonce":"8f46f2df64f8468efeaf9384","count":13,"sum":2115,"min":-443,"max":968,"sorted":[-443,-185,-166,-89,-79,-57,106,169,227,379,386,899,968]} |
| real-shell-failure-and-repair | passed | {"firstExit":7,"lastExit":0,"invocations":2,"validatorUnchanged":true} |
| native-subagent | passed | {"sum":2115,"nonce":"8f46f2df64f8468efeaf9384","workerSucceeded":true,"externalPiRequired":false} |

早期桌面运行曾停在既有计划审批并超时，原始失败记录保留在 artifacts/pi099-closeout/desktop-before-plan-approval。最终测试通过实际、版本绑定的审批按钮完成受控只读任务，没有绕过权限。

桌面记录与截图：`artifacts/pi099-closeout/desktop-live/`。临时凭据与隔离配置已删除：是。

## 覆盖边界

原生MCP使用真实本地stdio测试服务读写真实文件；OAuth使用本地授权服务器完成实际PKCE/刷新，不等同于验证每一家外部SaaS账号。未用真实采购、价格、付款或生产业务记录做破坏性写入。旧SSE/socket配置明确报错，需要提供支持的stdio/Streamable HTTP端点，不能伪装成已兼容。

现有旧adapter账户不自动搬运keyring凭据；需要OAuth的服务器应通过新的原生管理入口重新授权。

## 重跑

`pnpm run test:pi099-closeout` 运行命令级回归。

`node scripts/pi099-closeout-runner.cjs build` 构建；`node scripts/pi099-closeout-runner.cjs pack` 生成上述便携目录。

`pnpm run test:pi099-desktop` 运行真实模型桌面验收，会使用已授权供应商并产生相应调用费用；不会修改现有主账户配置。

`node scripts/pi099-closeout-audit.cjs` 汇总证据和构建后源码变动。
