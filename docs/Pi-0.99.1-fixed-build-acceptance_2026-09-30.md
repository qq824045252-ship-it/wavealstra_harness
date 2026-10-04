# Pi 0.99.1 修复与固定发行包验收

记录时间：2026-09-30T01:56:11.874Z

## 交付版本

实际仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`。Git 基线：`b79a885`，保留未提交改动，未自动提交。

固定发行包：`C:\Users\servi\Documents\GitHub\wavealstra_harness\release-pi099-verified-20260930014530105\win-unpacked\MyBuddy.exe`。未覆盖原有安装。

四个关键文件（EXE、app.asar、Codemode Worker、QuickJS WASM）均记录 SHA-256，并在真实任务结束后再次核对，全部一致。后续工作区改动不会自动进入这个发行包。

## 修复范围

| 问题 | 已落实处理 |
|---|---|
| 管理页与任务 MCP 执行链分裂 | 统一 Pi 原生 MCP，复用配置和加密授权存储，状态显式绑定会话；旧 adapter 依赖和执行构建链已移除。 |
| SDK 没有桌面管理页接口 | 增加固定 0.99.1 的 pnpm patch，仅暴露宿主状态和管理动作，仍执行 Pi 原生协议；后续升级需重新审查补丁。 |
| 打包后找不到 Worker/WASM | 打入原始 Worker 和 WASM，配置 asarUnpack 和显式路径，实际发行包执行验证通过。 |
| 原生工具被误当 MCP、只读被误拦 | 补全工具身份、精确服务器匹配；只读允许有明确证据的读取，拒绝子调用写入与其他副作用。 |
| 并发写入及取消 | 使用 Pi 原生执行队列：明确只读可并发，其他 MCP 调用串行；取消测试验证没有额外落盘。 |
| 子调用关系和历史丢失 | parentToolCallId 贯通事件/IPC/界面；从 Pi nestedCalls 恢复历史错误及取消状态，保留不完整记录警告。 |
| Shell 错误被记作退出 0 | 识别 Pi 0.99 的结构化 isError / exit_code，验证命令首次退出 7、修复输入后退出 0。 |
| OAuth 生命周期 | 真实原生 PKCE、凭证共享、401 刷新、退出/取消与销毁竞态有独立测试；OS 加密存储拒绝明文降级。 |
| ERP 入口移动 | 原配置已备份，仅修正失效 stdio 脚本路径，未修改 ERP 业务数据。 |

## 验证结果

| 组别 | 结果 |
|---|---|
| 收尾脚本（包含若干专项入口与类型检查） | 24/24 通过 |
| 原生 MCP 真实协议/临时文件集成场景 | 14/14 通过 |
| 本地 OAuth 协议场景 | 6/6 通过 |
| 真实模型 + SDK 任务 | 3/3 通过 |
| 真实模型 + 固定桌面发行包任务 | 4/4 通过 |
| 真实 Electron OS 加密、会话历史、固定包 Worker/WASM | 通过 |

这些组别存在包含关系，不应相加为互不重复的测试数。确定性模型驱动的 Agent 集成与真实供应商模型任务在原始报告中明确区分。

固定发行包的四类任务（跨首次运行与 SubAgent 审批复测，均为同一哈希固定副本）从实际输入框发送，经 IPC、原生工具及磁盘回读验收：

- repository-inventory：通过；{"total":680,"totalBytes":7886032,"largest":[{"path":"src/main/agent/AgentService.ts","bytes":250775},{"path":"src/renderer/src/store/appStore.ts","bytes":248342},{"path":"src/main/db/AppDatabase.ts","bytes":167004}]}
- unseen-input-transform：通过；{"nonce":"3e122f8762d99ac23ed38725","count":13,"sum":4612,"min":-436,"max":992,"sorted":[-436,-389,-389,-69,38,182,558,666,689,881,921,968,992]}
- real-shell-failure-and-repair：通过；{"firstExit":7,"lastExit":0,"invocations":2,"validatorUnchanged":true}
- native-subagent：通过；{"sum":-562,"nonce":"8b30c4d02a40da19f074d3cb","workerSucceeded":true,"externalPiRequired":false}

首次 SubAgent 尝试进入现有计划审批后等待超时，原失败记录保留。专项复测通过实际计划卡的批准按钮继续，不关闭权限检查、不伪造授权。

源码清单使用测试开始时从真实仓库复制的只读快照，防止并行编辑改变验收预期；随机输入在模型运行前生成，没有预填答案。命令失败恢复校验了验证脚本哈希未变。

## 尚未验证的外部条件

ERP 的本地 API 与 PostgreSQL 未运行，ERP 业务数据端到端测试被环境阻塞，不能声称已经通过。没有启动数据库迁移、导入采购单或修改库存。

OAuth 测试使用本地协议服务器，不代表 Canva 等外部账户已重新授权。旧凭证没有删除或盲目导入；原生 MCP 需要时应由用户完成对应服务授权。

## 证据与使用

最终索引：`artifacts/pi099-migration/frozen/final-verification.json`。原始日志与失败后的复测记录保留在 `artifacts/pi099-migration` 和 `artifacts/pi099-closeout`。

测试发行包可直接运行上述目录中的 MyBuddy.exe；它与旧安装并存。不要同时打开两个使用同一正式用户配置的 MyBuddy 实例。实际验收使用独立临时配置，其清理结果记录在桌面报告中。
