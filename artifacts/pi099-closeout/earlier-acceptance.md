# Pi 0.99.1 迁移修复与验收

记录时间：2026-09-30T01:38:26.314Z

## 已修复

- 主对话和 MCP 管理页统一复用 Pi 原生 MCP；旧 adapter 执行及构建链已清理。
- SDK 宿主状态/连接/授权桥使用版本固定的 pnpm patch；不另写 MCP 协议或 Agent 循环。
- Codemode 原始 Worker 和 QuickJS WASM 纳入构建及 asarUnpack，运行时显式定位。
- 工具身份识别、原生/旧命名兼容、只读拦截及 Pi 原生串行写队列已接通。
- 子调用 parentToolCallId 贯通事件、IPC、界面和会话历史；保留错误、取消及不完整记录标记。
- 原生 Shell isError / exit_code 结果不会再被审计成退出码 0。
- OAuth 凭证通过系统加密存储，管理页与任务共享；取消、退出及会话销毁不会启动迟到授权。
- ERP 配置已备份，仅修正了指向已迁移 stdio 脚本的失效路径。

## 验收结果

| 验证组 | 结果 |
|---|---|
| 收尾脚本（含类型检查及专项入口） | 24/24 通过 |
| 原生 MCP 专项场景 | 13/13 通过 |
| 本地 OAuth 协议场景 | 6/6 通过 |
| 实际模型 + 原生 SDK 任务 | 3/3 通过 |
| 实际模型 + 实际发行包桌面任务 | 3/3 通过 |
| Electron 系统加密、会话历史、发行包 Worker/WASM | 通过 |

这些统计分组有包含关系，不应相加后宣称为互不重复的测试总数。确定性 Agent 驱动的集成场景与真实模型任务在记录中分开。

桌面任务通过实际输入框、IPC、原生工具和文件回读完成：源码统计；随机输入变换；真实命令首次退出 7、修复输入后退出 0，验证脚本哈希未变。

## 已验证发行包

`release-pi099-closeout/win-unpacked/MyBuddy.exe`

未覆盖原有安装。测试使用独立配置与临时工作区，凭证未写入验收日志。

## 必须保留的边界

ERP 的本地 API 和 PostgreSQL 未运行，因此 ERP 业务数据端到端验收仍受环境阻塞。没有新增采购单、修改库存或执行数据库迁移。

外部账户没有被自动重新授权。本地 OAuth 测试覆盖真实协议与原生实现，但不等于 Canva 等第三方账户已经登录；旧授权存储未删除，新原生连接可能需要用户重新授权。

**打包后工作区仍有后续变更。** 最新工作区类型检查已通过，但不把这些后续变更冒充为已纳入上述发行包的完整验收：

- electron.vite.config.ts
- package.json
- src/main/capabilities/subagent/index.ts
- src/main/capabilities/subagent/invocation.ts
- src/main/capabilities/subagent/worker-launcher.mjs
- src/main/remote/RemoteAccessController.ts
- src/main/remote/RemoteNetwork.ts
- src/renderer/src/components/settings/RemoteAccessTab.tsx
- src/renderer/src/styles/global.css

## 证据

完整索引：`artifacts/pi099-closeout/final-verification.json`。原始测试日志、失败尝试和最终复测结果均保留。

未自动提交 Git，工作区原有改动未回退。
